'use strict'

const nodePath = require('path')
const GLOBSTAR = require('minimatch').GLOBSTAR
const glob = require('glob')
const identifierfy = require('identifierfy')

const dirname = nodePath.dirname
const relative = nodePath.relative
const resolve = nodePath.resolve
const fileSeparator = nodePath.sep
const hasMagic = glob.hasMagic
const GlobSync = glob.GlobSync

const twoStar = '(?:(?!(?:/|^)\\.).)*?' // match "**"

function makeSubpathExpressions (mm) {
  const set = mm.set
  const slen = set.length
  const result = []
  for (let s = 0; s < slen; s++) {
    const sn = (s + 1) % slen // next or first exp
    const exp = set[s]
    const parts = []

    let endParen = -1
    for (let e = 0; e < exp.length; e++) {
      let src
      let isDynamic = true
      const subexp = exp[e]
      if (subexp === GLOBSTAR) {
        src = twoStar
      } else if (typeof subexp !== 'string') {
        src = subexp.source.slice(1, -1)
      } else {
        src = regExpEscape(subexp)
        // if /{a,b}/ is used isDynamic will be true
        isDynamic = (exp[e] !== set[sn][e])
      }
      if (isDynamic) {
        if (endParen < 0) {
          src = '(' + src
        }
        endParen = e
      }
      parts.push(src)
    }
    parts[endParen] += ')'

    let extname
    const last = exp.length - 1
    if (typeof exp[last] !== 'string' || exp[last] !== set[sn][last]) {
      // grab extension from filename
      extname = mm.globParts[s][last].match(/(?:\.[A-Za-z0-9]+)*$/)[0]
    }

    result.push({
      regexp: new RegExp('^' + parts.join('/') + '$', 'i'),
      extname
    })
  }
  return result
}

function regExpEscape (s) {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

function generateMembers (gm, cwd) {
  const expressions = makeSubpathExpressions(gm.minimatch)
  return gm.found.map(file => {
    let subpath
    for (const exp of expressions) {
      const match = file.match(exp.regexp)
      if (match) {
        if (exp.extname) {
          subpath = match[1].slice(0, -exp.extname.length)
        } else {
          subpath = match[1]
        }
        break
      }
    }
    return {
      file,
      relative: './' + relative(cwd, resolve(cwd, file)),
      name: memberify(subpath)
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

        if (!hasMagic(pattern)) {
          if (pattern.startsWith('glob:')) {
            throw error(`Missing glob pattern '${pattern}'`)
          }
          return
        }

        if (pattern.startsWith('glob:')) {
          pattern = pattern.replace(/^glob:/, '')
        }

        if (hasImportDefaultSpecifier(specifiers)) {
          throw error('Cannot import the default member')
        }

        if (!pattern.startsWith('.')) {
          throw error(`Glob pattern must be relative, was '${pattern}'`)
        }

        const cwd = dirname(state.file.opts.filename)
        const gm = GlobSync(pattern, {cwd, strict: true})
        const members = generateMembers(gm, cwd)
        const unique = Object.create(null)
        for (const m of members) {
          if (m.name === null) {
            throw error(`Could not generate a valid identifier for '${m.file}'`)
          }
          if (unique[m.name]) {
            // hyphen conversion means foo-bar and fooBar will collide.
            throw error(`Found colliding members '${m.name}'`)
          }
          unique[m.name] = true
        }

        const replacement = []
        if (specifiers.length > 0) {
          for (const s of specifiers) {
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
              for (const m of members) {
                replacement.push(
                  makeImport(t, `_${localName}_${m.name}`, m.relative)
                )
              }
              replacement.push(
                makeNamespaceObject(t, localName, members),
                freezeNamespaceObject(t, localName)
              )
            }
          }
        } else {
          for (const m of members) {
            replacement.push(
              t.importDeclaration([], t.stringLiteral(m.relative))
            )
          }
        }
        path.replaceWithMultiple(replacement)
      }
    }
  }
}
