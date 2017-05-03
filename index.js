'use strict'

const path = require('path')
const escapeStringRegexp = require('escape-string-regexp')
const GLOBSTAR = require('minimatch').GLOBSTAR
const glob = require('glob')
const identifierfy = require('identifierfy')

const twoStar = '(?:(?!(?:/|^)\\.).)*?' // match "**"

function makeSubpathExpressions (minimatch) {
  return minimatch.set.map((expressions, index) => {
    const nextExpressions = minimatch.set[(index + 1) % minimatch.set.length]

    const parts = []
    let lastCaptureIndex = -1
    for (let expressionIndex = 0; expressionIndex < expressions.length; expressionIndex++) {
      const expression = expressions[expressionIndex]

      let capture = true
      let partialPattern
      if (typeof expression === 'string') {
        partialPattern = escapeStringRegexp(expression)
        // `capture` should only be true if brace expansion is used, and … some
        // other condition?
        // FIXME: What is the logic here? {a,b} will lead to capture, as will
        // {a,a*}. Is this to do with multiple braces being expanded? E.g.
        // {a,b}/foo/{c,d}?
        capture = expression !== nextExpressions[expressionIndex]
      } else if (expression === GLOBSTAR) {
        partialPattern = twoStar
      } else {
        partialPattern = expression.source.slice(1, -1)
      }

      if (capture) {
        if (lastCaptureIndex < 0) {
          partialPattern = '(' + partialPattern
        }
        lastCaptureIndex = expressionIndex
      }
      parts.push(partialPattern)
    }
    parts[lastCaptureIndex] += ')'

    const last = expressions.length - 1
    // FIXME: Why check for strings? What is the significance of the expressions[last] !== nextExpressions[last]?
    // Why not use path.extname()?
    const extname = typeof expressions[last] !== 'string' || expressions[last] !== nextExpressions[last]
      // grab extension from filename
      ? minimatch.globParts[index][last].match(/(?:\.[A-Za-z0-9]+)*$/)[0]
      : null

    return {
      // FIXME: Why even return extname? Can't it be excluded from the regexp match?
      regexp: new RegExp('^' + parts.join('/') + '$', 'i'),
      extname
    }
  })
}

function generateMembers (globObj, cwd) {
  const expressions = makeSubpathExpressions(globObj.minimatch)
  return globObj.found.map(file => {
    let subpath
    for (const expression of expressions) {
      const match = file.match(expression.regexp)
      if (match) {
        if (expression.extname) {
          subpath = match[1].slice(0, -expression.extname.length)
        } else {
          subpath = match[1]
        }
        break
      }
    }
    return {
      file,
      relative: './' + path.relative(cwd, path.resolve(cwd, file)),
      name: memberify(subpath)
    }
  })
}

function memberify (subpath) {
  const pieces = subpath.split(path.sep)
  const prefixReservedWords = pieces.length === 1
  const ids = []
  for (let index = 0; index < pieces.length; index++) {
    const name = pieces[index]
    const id = identifierfy(name, {
      prefixReservedWords,
      prefixInvalidIdentifiers: index === 0
    })
    if (id === null) {
      return null
    }
    ids.push(id)
  }
  return ids.join('$')
}

function hasImportDefaultSpecifier (specifiers) {
  return specifiers.some(specifier => specifier.type === 'ImportDefaultSpecifier')
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
  const properties = members.map(member => t.objectProperty(
    t.identifier(member.name), t.identifier(`_${localName}_${member.name}`)
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
      ImportDeclaration (ast, state) {
        const specifiers = ast.node.specifiers
        const source = ast.node.source
        const error = message => ast.buildCodeFrameError(message)

        let pattern = source.value

        if (!glob.hasMagic(pattern)) {
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

        const cwd = path.dirname(state.file.opts.filename)
        const globObj = new glob.GlobSync(pattern, {cwd, strict: true})
        const members = generateMembers(globObj, cwd)
        const unique = Object.create(null)
        for (const member of members) {
          if (member.name === null) {
            throw error(`Could not generate a valid identifier for '${member.file}'`)
          }
          if (unique[member.name]) {
            // hyphen conversion means foo-bar and fooBar will collide.
            throw error(`Found colliding members '${member.name}'`)
          }
          unique[member.name] = true
        }

        if (specifiers.length > 0) {
          const replacement = []
          for (const specifier of specifiers) {
            const type = specifier.type
            const localName = specifier.local.name
            if (type === 'ImportSpecifier') {
              const importName = specifier.imported.name
              const member = members.find(m => m.name === importName)
              if (!member) {
                const names = members.map(m => m.name).join("', '")
                throw error(`Could not match import '${importName}' to a module. Available members are '${names}'`)
              }
              replacement.push(makeImport(t, localName, member.relative))
            } else {
              // Only ImportNamespaceSpecifier can be remaining, since
              // importDefaultSpecifier has previously been rejected.
              for (const member of members) {
                replacement.push(makeImport(t, `_${localName}_${member.name}`, member.relative))
              }
              replacement.push(makeNamespaceObject(t, localName, members), freezeNamespaceObject(t, localName))
            }
          }
          ast.replaceWithMultiple(replacement)
        } else {
          ast.replaceWithMultiple(members.map(member => {
            return t.importDeclaration([], t.stringLiteral(member.relative))
          }))
        }
      }
    }
  }
}
