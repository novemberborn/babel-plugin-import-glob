import {
  dirname,
  relative,
  resolve,
  sep as fileSeparator
} from 'path'

import commonExtname from 'common-extname'
import commonPathPrefix from 'common-path-prefix'
import glob from 'glob'
import identifierfy from 'identifierfy'

function getPattern (path, source) {
  const pattern = source.value.replace(/^glob:/, '').trim()
  if (!pattern) {
    throw path.buildCodeFrameError(`Missing glob pattern '${source.value}'`)
  }
  if (/^\//.test(pattern)) {
    throw path.buildCodeFrameError(`Glob pattern must be relative, was '${pattern}'`)
  }
  return pattern
}

function rejectImportDefaultSpecifier (path, specifiers) {
  for (const { type } of specifiers) {
    if (type === 'ImportDefaultSpecifier') {
      throw path.buildCodeFrameError('Cannot import the default member')
    }
  }
}

export default function ({ types: t }) {
  return {
    visitor: {
      ImportDeclaration (path, file) {
        const { node: { specifiers, source } } = path
        if (!t.isStringLiteral(source) || !/^glob:/.test(source.value)) {
          return
        }

        rejectImportDefaultSpecifier(path, specifiers)

        const fromDir = dirname(file.file.opts.filename)
        const matches = glob.sync(getPattern(path, source), {
          // Search relative to the source file, assuming that location is
          // derived correctly.
          cwd: fromDir,
          strict: true
        })

        const prefix = commonPathPrefix(matches)
        const suffix = commonExtname(matches)

        const lookup = Object.create(null)
        const members = []
        for (const filepath of matches) {
          const src = './' + relative(fromDir, resolve(fromDir, filepath))
          const subpath = filepath.slice(prefix.length, filepath.length - suffix.length)
          const pieces = subpath.split(fileSeparator)
          const member = pieces.map((name, index) => {
            const id = identifierfy(name, {
              prefixReservedWords: pieces.length === 1,
              prefixInvalidIdentifiers: index === 0
            })
            if (id === null) {
              throw path.buildCodeFrameError(`Could not generate a valid identifier for '${src}'. The '${name}' component could not be converted.`)
            }
            return id
          }).join('$')

          if (lookup[member]) {
            // hyphen conversion means foo-bar and fooBar will collide.
            throw path.buildCodeFrameError(`Found colliding members '${member}'`)
          }

          lookup[member] = src
          members.push(member)
        }

        if (specifiers.length === 0) {
          path.replaceWithMultiple(members.map(member => t.importDeclaration([], t.stringLiteral(lookup[member]))))
          return
        }

        const makeImport = (localName, src) => t.importDeclaration([t.importDefaultSpecifier(t.identifier(localName))], t.stringLiteral(src))
        const makeNamespaceObject = localName => {
          const properties = members.map(member => t.objectProperty(t.identifier(member), t.identifier(`_${localName}_${member}`)))
          return t.variableDeclaration('const', [t.variableDeclarator(t.identifier(localName), t.objectExpression(properties))])
        }
        const freezeNamespaceObject = localName => {
          return t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier('Object'), t.identifier('freeze')),
              [t.identifier(localName)]))
        }

        const replacement = specifiers.map(({ type, imported, local: { name: localName } }) => {
          if (type === 'ImportSpecifier') {
            const { name: importName } = imported
            if (!lookup[importName]) {
              throw path.buildCodeFrameError(`Could not match import '${importName}' to a module. Available members are '${members.join("', '")}'`)
            }

            return makeImport(localName, lookup[importName])
          }

          // Only ImportNamespaceSpecifier can be remaining, since
          // importDefaultSpecifier has previously been rejected.
          return [].concat(
            members.map(member => makeImport(`_${localName}_${member}`, lookup[member])),
            makeNamespaceObject(localName, members),
            freezeNamespaceObject(localName)
          )
        })
        path.replaceWithMultiple([].concat(...replacement))
      }
    }
  }
}
