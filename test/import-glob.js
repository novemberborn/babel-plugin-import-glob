import { resolve as resolvePath } from 'path'
import test from 'ava'
import { transform as babelTransform } from 'babel-core'

function transform (code) {
  return babelTransform(code, {
    babelrc: false,
    filename: __filename,
    sourceRoot: __dirname,
    plugins: [resolvePath(__dirname, '..')]
  }).code
}

function attempt (code) {
  return new Promise(resolve => resolve(transform(code)))
}

function check (msg) {
  const preface = `${__filename}: `
  return err => err instanceof SyntaxError && err.message.slice(0, preface.length) === preface && err.message.slice(preface.length) === msg
}

test('throws if import does not contain a pattern', t => {
  t.throws(
    attempt("import { foo } from 'glob:'"),
    check("Missing glob pattern 'glob:'"))
})

test('throws if pattern is absolute', t => {
  t.throws(
    attempt("import { foo } from 'glob:/root'"),
    check("Glob pattern must be relative, was '/root'"))
})

test('throws if a member identifier cannot be generated', t => {
  t.throws(
    attempt("import * as members from 'glob:fixtures/cannot-generate-identifier/*.txt'"),
    check("Could not generate a valid identifier for './fixtures/cannot-generate-identifier/-.txt'. The '-' component could not be converted."))
})

test('throws if members collide', t => {
  t.throws(
    attempt("import { fooBar } from 'glob:fixtures/member-collision/*.txt'"),
    check("Found colliding members 'fooBar'"))
})

test('throws if imports cannot be mapped', t => {
  t.throws(
    attempt("import { baz } from 'glob:fixtures/foo-bar/*.txt'"),
    check("Could not match import 'baz' to a module. Available members are 'fooBar'"))
})

test("cannot map 'toString'", t => {
  t.throws(
    attempt("import { toString } from 'glob:fixtures/foo-bar/*.txt'"),
    SyntaxError)
})

test('throws when importing the default member', t => {
  t.throws(
    attempt("import fooBar from 'glob:fixtures/foo-bar/*.txt'"),
    check('Cannot import the default member'))
})

test('rewrites the import statement', t => {
  t.is(
    transform("import { foo, bar } from 'glob:fixtures/multiple/*.txt'"),
    `import foo from './fixtures/multiple/foo.txt';
import bar from './fixtures/multiple/bar.txt';`)
})

test('constructs the member by identifierfying the file name, without the common extname', t => {
  t.is(
    transform("import { fooBar } from 'glob:fixtures/foo-bar/*.txt'"),
    "import fooBar from './fixtures/foo-bar/foo-bar.txt';")
})

test('constructs the member by identifierfying the file name, including remaining extnames', t => {
  t.is(
    transform("import { fooBar, bazQux } from 'glob:fixtures/extnames/*.txt'"),
    `import fooBar from './fixtures/extnames/foo.bar.txt';
import bazQux from './fixtures/extnames/baz.qux.txt';`)
})

test('constructs the member by identifierfying directory components, separating them by dollar signs', t => {
  t.is(
    transform("import { fooBar$baz, qux$quux } from 'glob:fixtures/subdirectories/**/*.txt'"),
    `import fooBar$baz from './fixtures/subdirectories/foo-bar/baz.txt';
import qux$quux from './fixtures/subdirectories/qux/quux.txt';`)
})

test('constructs the member by identifierfying directory components, without unnecessary underscores', t => {
  t.is(
    transform("import { noUnnecessaryUnderscores$new, noUnnecessaryUnderscores$42 } from 'glob:fixtures/subdirectories/**/*.txt'"),
    `import noUnnecessaryUnderscores$new from './fixtures/subdirectories/no-unnecessary-underscores/new.txt';
import noUnnecessaryUnderscores$42 from './fixtures/subdirectories/no-unnecessary-underscores/42.txt';`)

  t.is(
    transform("import { _new, _42 } from 'glob:fixtures/necessary-underscores/*.txt'"),
    `import _new from './fixtures/necessary-underscores/new.txt';
import _42 from './fixtures/necessary-underscores/42.txt';`)
})

test('normalizes the source path irrespective of pattern', t => {
  t.is(
    transform("import { fooBar } from 'glob:../test/fixtures/foo-bar/*.txt'"),
    "import fooBar from './fixtures/foo-bar/foo-bar.txt';")
})

test('supports importing directories', t => {
  t.is(
    transform("import { extnames, fooBar } from 'glob:fixtures/*'"),
    `import extnames from './fixtures/extnames';
import fooBar from './fixtures/foo-bar';`)
})

test('supports aliasing members', t => {
  t.is(
    transform("import { fooBar as fb } from 'glob:fixtures/foo-bar/*.txt'"),
    "import fb from './fixtures/foo-bar/foo-bar.txt';")
})

test('supports importing the entire glob pattern as a namespace object', t => {
  t.is(
    transform("import * as members from 'glob:fixtures/multiple/*.txt'"),
    `import _members_bar from './fixtures/multiple/bar.txt';
import _members_foo from './fixtures/multiple/foo.txt';
const members = {
  bar: _members_bar,
  foo: _members_foo
};
Object.freeze(members);`)
})

test('supports importing modules for their side-effects', t => {
  t.is(
    transform("import 'glob:fixtures/multiple/*.txt'"),
    `import './fixtures/multiple/bar.txt';
import './fixtures/multiple/foo.txt';`)
})
