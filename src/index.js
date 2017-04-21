import {
  dirname,
  relative,
  resolve,
  sep as fileSeparator
} from 'path'

import {GlobSync} from 'glob/sync'
import {GLOBSTAR} from 'minimatch'
import {hasMagic} from 'glob'
import commonExtname from 'common-extname'
import commonPathPrefix from 'common-path-prefix'
import identifierfy from 'identifierfy'

const star = '[^/]*?'
const twoStarDot = '(?:(?!(?:/|^)(?:\\.{1,2})($|/)).)*?'
const twoStarNoDot = '(?:(?!(?:/|^)\\.).)*?'

function generateMembers ({found, minimatch: {set, options}}, cwd, index) {
  let members
  const rp = file => './' + relative(cwd, resolve(cwd, file))
  if (index >= 0) {
    const twoStar = '(' + (options.noglobstar ? star
      : options.dot ? twoStarDot
      : twoStarNoDot) + ')'
    const flags = options.nocase ? 'i' : ''
    const ps = set[0]
    const regexp = new RegExp(
      '^(?:' + ps.map(p => (p === GLOBSTAR) ? twoStar
        : (typeof p === 'string') ? regExpEscape(p)
        : '(' + p._src + ')').join('/') + ')$', flags
    )
    const count = ps.reduce((c, p) => typeof p !== 'string' ? c + 1 : c, 0)
    const last = count - 1
    if (index > last) {
      index = last
    }
    const fileIndex = typeof ps[ps.length - 1] !== 'string' && last
    if (index === fileIndex) {
      const suffix = commonExtname(found).length
      members = found.map(f => {
        const p = f.match(regexp)[index + 1]
        return {
          file: f,
          relative: rp(f),
          name: memberify(p.slice(0, p.length - suffix))
        }
      })
    } else {
      members = found.map(f => ({
        file: f,
        relative: rp(f),
        name: memberify(f.match(regexp)[index + 1])
      }))
    }
  } else {
    const prefix = commonPathPrefix(found).length
    const suffix = commonExtname(found).length
    members = found.map(f => ({
      file: f,
      relative: rp(f),
      name: memberify(f.slice(prefix, f.length - suffix))
    }))
  }
  return members
}

function regExpEscape (s) {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

function memberify (subpath) {
  const pieces = subpath.split(fileSeparator)
  const prefixReservedWords = pieces.length === 1
  const ids = []
  for (let i = 0; i < pieces.length; i++) {
    const name = pieces[i]
    const id = identifierfy(name, {
      prefixReservedWords,
      prefixInvalidIdentifiers: i === 0
    })
    if (id === null) {
      return null
    }
    ids.push(id)
  }
  return ids.join('$')
}

function hasImportDefaultSpecifier (specifiers) {
  for (const { type } of specifiers) {
    if (type === 'ImportDefaultSpecifier') {
      return true
    }
  }
  return false
}

function indexFromImportSpecifier (specifiers) {
  const specifier = specifiers.find(({ type, imported }) =>
    type === 'ImportSpecifier' && /^\$[0-9]+$/.test(imported.name)
  )
  if (!specifier) {
    return -1
  }
  return Number(specifier.imported.name.substr(1))
}

function makeImport (t, localName, src) {
  return t.importDeclaration([
    t.importDefaultSpecifier(t.identifier(localName))
  ], t.stringLiteral(src))
}

function freezeNamespaceObject (t, localName) {
  return t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('Object'), t.identifier('freeze')),
      [t.identifier(localName)]
    )
  )
}

function makeNamespaceObject (t, localName, members) {
  const properties = members.map(m => t.objectProperty(
    t.identifier(m.name), t.identifier(`_${localName}_${m.name}`)
  ))
  return t.variableDeclaration(
    'const', [
      t.variableDeclarator(
        t.identifier(localName),
        t.objectExpression(properties)
      )
    ]
  )
}

export default function ({ types: t }) {
  return {
    visitor: {
      ImportDeclaration (path, state) {
        const { node: { specifiers, source } } = path
        const error = message => path.buildCodeFrameError(message)

        if (!t.isStringLiteral(source)) {
          return
        }

        let pattern = source.value
        if (/^glob:/.test(pattern)) {
          pattern = pattern.replace(/^glob:/, '')
        } else if (!hasMagic(pattern)) {
          return
        }

        if (hasImportDefaultSpecifier(specifiers)) {
          throw error('Cannot import the default member')
        }

        if (!pattern) {
          throw error(`Missing glob pattern '${pattern}'`)
        }

        if (/^\//.test(pattern)) {
          throw error(`Glob pattern must be relative, was '${pattern}'`)
        }

        const index = indexFromImportSpecifier(specifiers)
        if (index >= 0 && specifiers.length > 1) {
          throw error(`Cannot mix indexed members`)
        }

        const cwd = dirname(state.file.opts.filename)
        const gm = GlobSync(pattern, {cwd, strict: true})
        const members = generateMembers(gm, cwd, index)
        const unique = Object.create(null)
        members.forEach(({file, name}) => {
          if (name === null) {
            throw error(`Could not generate a valid identifier for '${file}'`)
          }
          if (unique[name]) {
            // hyphen conversion means foo-bar and fooBar will collide.
            throw error(`Found colliding members '${name}'`)
          }
          unique[name] = true
        })

        if (specifiers.length === 0) {
          path.replaceWithMultiple(members.map(
            m => t.importDeclaration(
              [], t.stringLiteral(m.relative))
            )
          )
          return
        }

        const replacement = specifiers.map(({ type, imported, local: { name: localName } }) => {
          if (index < 0 && type === 'ImportSpecifier') {
            const { name: importName } = imported
            const member = members.find(m => m.name === importName)
            if (!member) {
              const names = members.map(m => m.name).join("', '")
              throw error(`Could not match import '${importName}' to a module. Available members are '${names}'`)
            }
            return makeImport(t, localName, member.relative)
          }

          // Only ImportNamespaceSpecifier can be remaining, since
          // importDefaultSpecifier has previously been rejected.
          return [].concat(
            members.map(m => makeImport(t, `_${localName}_${m.name}`, m.relative)),
            makeNamespaceObject(t, localName, members),
            freezeNamespaceObject(t, localName)
          )
        })
        path.replaceWithMultiple([].concat(...replacement))
      }
    }
  }
}
