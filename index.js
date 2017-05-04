'use strict'

const path = require('path')
const escapeStringRegexp = require('escape-string-regexp')
const GLOBSTAR = require('minimatch').GLOBSTAR
const glob = require('glob')
const identifierfy = require('identifierfy')
const uniq = require('lodash.uniq')
const findLastIndex = require('lodash.findlastindex')

const twoStar = '(?:(?!(?:/|^)\\.).)*?' // match '**'

// flattenSet flattens multiple expressions from minimatch
//
// given 'foo/**/{bar, bat}/*.txt', set would be
//   [
//     [ 'foo', GLOBSTAR, 'bar', /[^\/]+\.txt/ ],
//     [ 'foo', GLOBSTAR, 'bat', /[^\/]+\.txt/ ]
//   ]
//
// flatten it to
//   [ 'foo', twoStar, [ 'bar', 'bat' ], '[^/]+\.txt' ]
//
function flattenSet (set) {
  return set[0].map((firstExpression, index) => {
    if (firstExpression === GLOBSTAR) {
      return [twoStar]
    }
    let subExpressions = set.map(expressions => expressions[index])
    if (typeof firstExpression === 'string') {
      subExpressions = uniq(subExpressions.map(
        subexp => escapeStringRegexp(subexp)
      ))
      if (subExpressions.length === 1) {
        return subExpressions[0]
      }
    } else {
      subExpressions = uniq(subExpressions.map(
        subexp => subexp.source.slice(1, -1)
      ))
    }
    return subExpressions
  })
}

// joinExpression joins subexpressions to simplest form
//
//   ['one'] to 'one'
//   ['one', 'two'] to '(?:one|two)'
//
function joinExpression (expression) {
  if (expression.length > 1) {
    return '(?:' + expression.join('|') + ')'
  }
  return expression[0]
}

// splitExtensions takes a RegExp string and splits off extension
//
// given [ '[^/]+\.txt', '[^/]+\.csv' ]
// becomes [ [ '[^/]+', '[^/]+' ], [ '\.txt', '\.csv' ] ]
//
function splitExtensions (expressions) {
  const filenames = []
  const extensions = []
  for (const expression of expressions) {
    const extension = expression.match(/(?:\\\.[A-Za-z0-9]+)*$/)[0]
    if (extension) {
      filenames.push(expression.slice(0, -extension.length))
      extensions.push(extension)
    } else {
      filenames.push(expression)
    }
  }
  return [filenames, extensions]
}

function makeSubpathExpression (set) {
  const expressions = flattenSet(set)
  const captureStart = expressions.findIndex(Array.isArray)
  const captureStop = findLastIndex(expressions, Array.isArray)

  let extensionExpression = []
  if (captureStop === expressions.length - 1) {
    const split = splitExtensions(expressions[captureStop])
    expressions[captureStop] = uniq(split[0])
    extensionExpression = uniq(split[1])
  }

  const joinedExpressions = expressions.map(expression =>
    Array.isArray(expression) ? joinExpression(expression) : expression
  )

  joinedExpressions[captureStart] = '(' + joinedExpressions[captureStart]
  joinedExpressions[captureStop] += ')'

  let finalExpression = joinedExpressions.join('/')

  if (extensionExpression.length > 0) {
    finalExpression += joinExpression(extensionExpression)
  }

  return '^' + finalExpression + '$'
}

function generateMembers (globObj, cwd) {
  const expression = makeSubpathExpression(globObj.minimatch.set)
  const regexp = new RegExp(expression, 'i')
  return globObj.found.map(file => {
    const match = file.match(regexp)
    const subpath = match[1]
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
