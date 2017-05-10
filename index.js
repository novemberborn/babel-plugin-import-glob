'use strict'

const path = require('path')
const escapeStringRegexp = require('escape-string-regexp')
const GLOBSTAR = require('minimatch').GLOBSTAR
const glob = require('glob')
const identifierfy = require('identifierfy')
const findLastIndex = require('lodash.findlastindex')

const twoStar = '(?:(?!(?:/|^)\\.).)*?' // match '**'
const OPTIONAL = Symbol('Optional part')

// Recombines a set of minimatch patterns.
//
// Given `foo/**/{bar, bat}/*.txt`, minimatch would yield:
//
//     [
//       ['foo', GLOBSTAR, 'bar', /^[^\/]+\.txt$/],
//       ['foo', GLOBSTAR, 'bat', /^[^\/]+\.txt$/]
//     ]
//
// Which is recombined to:
//
//     [
//       { capture: false, patterns: ['foo'], optional: false },
//       { capture: true, patterns: [twoStar], optional: false },
//       { capture: true, patterns: ['bar', 'bat'], optional: false },
//       { capture: true, patterns: ['[^/]+\.txt'], optional: false }
//     ]
//
// Given `{a,b/c}d.txt`, minimatch would yield:
//
//     [
//       ['a', 'd.txt'],
//       ['b', 'c', 'd.txt']
//     ]
//
// Which is recombined to:
//
//     [
//       { capture: true, patterns: ['a', 'b'], optional: false },
//       { capture: true, patterns: ['c'], optional: true },
//       { capture: false, patterns: ['d.txt'], optional: false }
//     ]
//
function recombinePatterns (set) {
  const maxLength = set.reduce((length, patterns) => Math.max(length, patterns.length), 0)

  const initial = Array.from({length: maxLength}, () => new Set())
  const lastIndex = maxLength - 1
  for (const patterns of set) {
    for (let index = 0; index < maxLength; index++) {
      if (index < patterns.length - 1) {
        initial[index].add(patterns[index])
      } else {
        const pattern = patterns[index]
        for (; index < lastIndex; index++) {
          initial[index].add(OPTIONAL)
        }
        initial[lastIndex].add(pattern)
      }
    }
  }

  return initial.map(accumulated => {
    if (accumulated.has(GLOBSTAR)) {
      return {capture: true, optional: false, patterns: [twoStar]}
    }

    const raw = Array.from(accumulated)
    const capture = accumulated.size > 1 || typeof raw[0] !== 'string'
    const optional = accumulated.has(OPTIONAL)
    const patterns = raw
      .filter(pattern => pattern !== OPTIONAL)
      .map(pattern => {
        return typeof pattern === 'string'
          ? escapeStringRegexp(pattern)
          : pattern.source.slice(1, -1) // pattern is a regular expression
      })

    return {capture, optional, patterns}
  })
}

// Takes RegExp strings and extract file extensions.
//
// Given:
//
//     ['[^/]+\.txt', '[^/]+\.csv']
//
// Returns:
//
//    {
//      patterns: ['[^/]+'],
//      extensions: ['\.txt', '\.csv']
//    }
//
function extractExtensions (fullPatterns) {
  const patterns = new Set()
  const extensions = new Set()
  for (const pattern of fullPatterns) {
    const match = pattern.match(/^(.*?)((?:\\\.[A-Za-z0-9]+)*)$/)
    patterns.add(match[1])
    if (match[2]) {
      extensions.add(match[2])
    }
  }

  return {
    patterns: Array.from(patterns),
    extensions: Array.from(extensions)
  }
}

function mustCapture (part) {
  return part.capture === true
}

function makeSubpathExpression (set) {
  const parts = recombinePatterns(set)
  const captureStart = parts.findIndex(mustCapture)
  const captureEnd = findLastIndex(parts, mustCapture)
  const captureThroughEnd = captureEnd === parts.length - 1

  return '^' + parts.reduce((acc, part, index) => {
    let patterns = part.patterns
    let extensions
    if (index === captureEnd && captureThroughEnd) {
      const extracted = extractExtensions(part.patterns)
      patterns = extracted.patterns
      if (extracted.extensions.length > 0) {
        extensions = extracted.extensions
      }
    }

    let expression = `(?:${patterns.join('|')})`
    if (index === captureStart) {
      expression = '(' + expression
    }
    // Note that the slash is excluded from the start of the capture group.
    if (index > 0) {
      expression = '/' + expression
    }

    // Make the expression optional before possibly ending the capture group,
    // otherwise the capture group may become optional.
    if (part.optional) {
      expression = `(?:${expression})?`
    }

    if (index === captureEnd) {
      expression += ')'

      // Add non-captured extensions after the capture group has ended.
      if (captureThroughEnd && extensions) {
        expression += `(?:${extensions.join('|')})`
      }
    }

    return acc + expression
  }, '') + '$'
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
