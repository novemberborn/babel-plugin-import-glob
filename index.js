'use strict'

const nodePath = require('path')

const commonExtname = require('common-extname')
const commonPathPrefix = require('common-path-prefix')
const glob = require('glob')
const identifierfy = require('identifierfy')
const flatten = require('lodash.flatten')

function getPattern (path, source) {
  const pattern = source.value.replace(/^glob:/, '').trim()
  if (!pattern) {
    throw path.buildCodeFrameError(`Missing glob pattern '${source.value}'`)
  }
  if (pattern.startsWith('/')) {
    throw path.buildCodeFrameError(`Glob pattern must be relative, was '${pattern}'`)
  }
  return pattern
}

function rejectImportDefaultSpecifier (path, specifiers) {
  for (const specifier of specifiers) {
    if (specifier.type === 'ImportDefaultSpecifier') {
      throw path.buildCodeFrameError('Cannot import the default member')
    }
  }
}

module.exports = babelCore => {
  const t = babelCore.types

  return {
    visitor: {
      ImportDeclaration (path, file) {
        const node = path.node
        if (!t.isStringLiteral(node.source)) {
          return
        }

        if (!node.source.value.startsWith('glob:') && !glob.hasMagic(node.source.value)) {
          return
        }

        rejectImportDefaultSpecifier(path, node.specifiers)

        const fromDir = nodePath.dirname(file.file.opts.filename)
        const matches = glob.sync(getPattern(path, node.source), {
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
          const src = './' + nodePath.relative(fromDir, nodePath.resolve(fromDir, filepath))
          const subpath = filepath.slice(prefix.length, filepath.length - suffix.length)
          const pieces = subpath.split(nodePath.sep)
          const member = pieces.map((name, index) => {
            const id = identifierfy(name, {
              prefixReservedWords: pieces.length === 1,
              prefixInvalidIdentifiers: index === 0
            })
            if (id === null) {
              throw path.buildCodeFrameError(
                `Could not generate a valid identifier for '${src}'. The '${name}' component could not be converted.`)
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

        if (node.specifiers.length === 0) {
          path.replaceWithMultiple(members.map(member => t.importDeclaration([], t.stringLiteral(lookup[member]))))
          return
        }

        const makeImport = (localName, src) => {
          return t.importDeclaration([t.importDefaultSpecifier(t.identifier(localName))], t.stringLiteral(src))
        }
        const makeNamespaceObject = localName => {
          const properties = members.map(member => {
            return t.objectProperty(t.identifier(member), t.identifier(`_${localName}_${member}`))
          })
          return t.variableDeclaration('const', [t.variableDeclarator(t.identifier(localName), t.objectExpression(properties))])
        }
        const freezeNamespaceObject = localName => {
          return t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier('Object'), t.identifier('freeze')),
              [t.identifier(localName)]))
        }

        const replacement = node.specifiers.map(specifier => {
          const localName = specifier.local.name
          if (specifier.type === 'ImportSpecifier') {
            const importName = specifier.imported.name
            if (!lookup[importName]) {
              throw path.buildCodeFrameError(
                `Could not match import '${importName}' to a module. Available members are '${members.join("', '")}'`)
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
        path.replaceWithMultiple(flatten(replacement))
      }
    }
  }
}
