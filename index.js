'use strict'

const nodePath = require('path')
const GlobSync = require('glob/sync').GlobSync
const GLOBSTAR = require('minimatch').GLOBSTAR
const hasMagic = require('glob').hasMagic
const commonExtname = require('common-extname')
const commonPathPrefix = require('common-path-prefix')
const identifierfy = require('identifierfy')

const dirname = nodePath.dirname
const relative = nodePath.relative
const resolve = nodePath.resolve
const fileSeparator = nodePath.sep

const star = '[^/]*?'
const twoStarDot = '(?:(?!(?:/|^)(?:\\.{1,2})($|/)).)*?'
const twoStarNoDot = '(?:(?!(?:/|^)\\.).)*?'

function generateMembers (gm, cwd, index) {
  const found = gm.found
  const set = gm.minimatch.set
  const options = gm.minimatch.options
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
  for (const s of specifiers) {
    if (s.type === 'ImportDefaultSpecifier') {
      return true
    }
  }
  return false
}

function indexFromImportSpecifier (specifiers) {
  const specifier = specifiers.find(s =>
    s.type === 'ImportSpecifier' && /^\$[0-9]+$/.test(s.imported.name)
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

module.exports = babelCore => {
  const t = babelCore.types
  return {
    visitor: {
      ImportDeclaration (path, state) {
        const specifiers = path.node.specifiers
        const source = path.node.source
        const error = message => path.buildCodeFrameError(message)

        let pattern = source.value
        let assumeRel = false
        if (pattern.startsWith('glob:')) {
          pattern = pattern.replace(/^glob:/, '')
          assumeRel = true
        } else if (!hasMagic(pattern)) {
          return
        }

        if (hasImportDefaultSpecifier(specifiers)) {
          throw error('Cannot import the default member')
        }

        if (!pattern) {
          throw error(`Missing glob pattern '${pattern}'`)
        }

        if (pattern.startsWith('/') || (!assumeRel && !pattern.startsWith('.'))) {
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
        members.forEach(m => {
          if (m.name === null) {
            throw error(`Could not generate a valid identifier for '${m.file}'`)
          }
          if (unique[m.name]) {
            // hyphen conversion means foo-bar and fooBar will collide.
            throw error(`Found colliding members '${m.name}'`)
          }
          unique[m.name] = true
        })

        const replacement = []
        specifiers.forEach(s => {
          const type = s.type
          const localName = s.local.name
          if (index < 0 && type === 'ImportSpecifier') {
            const importName = s.imported.name
            const member = members.find(m => m.name === importName)
            if (!member) {
              const names = members.map(m => m.name).join("', '")
              throw error(`Could not match import '${importName}' to a module. Available members are '${names}'`)
            }
            replacement.push(makeImport(t, localName, member.relative))
          } else {
            // Only ImportNamespaceSpecifier can be remaining, since
            // importDefaultSpecifier has previously been rejected.
            members.forEach(
              m => replacement.push(
                  makeImport(t, `_${localName}_${m.name}`, m.relative)
              )
            )
            replacement.push(
              makeNamespaceObject(t, localName, members),
              freezeNamespaceObject(t, localName)
            )
          }
        })

        if (replacement.length === 0) {
          members.forEach(
            m => replacement.push(
                t.importDeclaration([], t.stringLiteral(m.relative))
            )
          )
        }

        path.replaceWithMultiple(replacement)
      }
    }
  }
}
