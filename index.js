'use strict'

const path = require('path')
const glob = require('glob')
const capture = require('minimatch-capture')
const identifierfy = require('identifierfy')

function generateMembers (files, pattern, cwd) {
  return capture.match(files, pattern).map(match => {
    const file = match[0]
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

const globPrefix = 'glob:'

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
          if (pattern.startsWith(globPrefix)) {
            throw error(`Missing glob pattern '${pattern}'`)
          }
          return
        }

        if (pattern.startsWith(globPrefix)) {
          pattern = pattern.substr(globPrefix.length)
        }

        if (hasImportDefaultSpecifier(specifiers)) {
          throw error('Cannot import the default member')
        }

        if (!pattern.startsWith('.')) {
          throw error(`Glob pattern must be relative, was '${pattern}'`)
        }

        const cwd = path.dirname(state.file.opts.filename)
        const files = glob.sync(pattern, {cwd, strict: true})
        const members = generateMembers(files, pattern, cwd)
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
