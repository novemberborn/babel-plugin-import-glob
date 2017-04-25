'use strict'

const nodePath = require('path')
const GlobSync = require('glob/sync').GlobSync
const GLOBSTAR = require('minimatch').GLOBSTAR
const hasMagic = require('glob').hasMagic
const identifierfy = require('identifierfy')

const dirname = nodePath.dirname
const relative = nodePath.relative
const resolve = nodePath.resolve
const fileSeparator = nodePath.sep

function makeRe (set) {
  let min, max
  const parts = []
  for (let i = 0; i < set.length; i++) {
    const p = set[i]
    if (typeof p !== 'string') {
      if (p === GLOBSTAR) {
        parts.push('(?:(?!(?:/|^)\\.).)*?')
      } else {
        parts.push(p._src)
      }
      if (min === undefined) {
        min = i
      }
      max = i
    } else {
      parts.push(p.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'))
    }
  }
  parts[max] += ')'
  parts[min] = '(' + parts[min]
  return '^' + parts.join('/') + '$'
}

function extLen (set) {
  const last = set[set.length - 1]
  if (typeof last === 'string' || last === GLOBSTAR) {
    return 0
  }
  return last._glob.match(/(?:\.[^.*?!+@[\]()]+)*$/)[0].length
}

function generateMembers (gm, cwd) {
  const found = gm.found
  const set = gm.minimatch.set[0]
  const regexp = new RegExp(makeRe(set), 'i')
  const ext = extLen(set)
  return found.map(file => {
    let part = file.match(regexp)[1]
    if (ext) {
      part = part.slice(0, -ext)
    }
    return {
      file,
      relative: './' + relative(cwd, resolve(cwd, file)),
      name: memberify(part)
    }
  })
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
        if (pattern.startsWith('glob:')) {
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

        if (!pattern.startsWith('.')) {
          throw error(`Glob pattern must be relative, was '${pattern}'`)
        }

        const cwd = dirname(state.file.opts.filename)
        const gm = GlobSync(pattern, {cwd, strict: true})
        const members = generateMembers(gm, cwd)
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
          if (type === 'ImportSpecifier') {
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
