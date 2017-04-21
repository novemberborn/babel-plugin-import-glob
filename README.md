# babel-plugin-import-glob

Babel plugin to enable importing modules using a [glob
pattern](https://www.npmjs.com/package/glob#glob-primer). Tested with Node.js
4 and above.

## Installation

```
npm install --save-dev babel-plugin-import-glob
```

Then add `import-glob` to your `.babelrc` file, like:

```json
{
  "plugins": ["import-glob"]
}
```

## Usage

This plugin is useful if you have multiple modules but you don't want to import
them one at a time.

Maybe you're using the
[`handlebars-inline-precompile`](https://github.com/thejameskyle/babel-plugin-handlebars-inline-precompile)
plugin and are putting your modules in a `templates` directory. Or you need to
dynamically reference one out of several classes and don't want to maintain the
lookup by hand. Perhaps you need to load multiple modules for their side-effects
and wish to simply add them to a directory without additional work. If so, this
plugin is for you!

*Of course in the vast majority of cases you should just use normal import
statements. Don't go overboard using this plugin.*

You can import the **default members** of any matching module. Let's say you
have a directory layout like this:

* `index.js`
* `templates/main.handlebars.js`
* `templates/_partial.handlebars.js`

In `index.js` you can write:

```js
import { main, _partial } from './templates/*.handlebars.js'
```

You can add an optional `glob:` prefix:

```js
import { main, _partial } from 'glob:./templates/*.handlebars.js'
```

You can alias members:

```js
import { main, _partial as partial } from './templates/*.handlebars.js'
```

Or import all matches into a namespace object:

```js
import * as templates from './templates/*.handlebars.js'
// Provides `templates.main` and `templates._partial`
```

Note that you **cannot import the default** from the glob pattern. The following
**won't work** and throws a `SyntaxError`:

```js
import myTemplates from './templates/*.handlebars.js' // This will throw a SyntaxError
```

You can load modules for their side-effects though:

```js
import './modules-with-side-effects/*.js'
```

If you have a directory layout like this:
* `index.js`
* `section1/main.js`
* `section2/main.js`

And you write this in `index.js`:

```js
import * as sections from './*/main.js'
```

Your identifiers end up being `section1$main` and `section2$main`. If you just want `section1` and `section2` you can write this instead:

```js
import { $0 as sections } from './*/main.js'
```

`$[0-9]+` refers to each globbed portion within the path.

This will throw a `SyntaxError`:

```js
import { $0 as sections, section1 } from './*/main.js'
```

### Glob patterns

The plugin uses the `glob` package. Please refer to [its documentation regarding
the pattern syntax](https://www.npmjs.com/package/glob#glob-primer).

The glob pattern must be relative. It may start with `./` or `../`. If `glob:` prefix is included and you don't
specify either then `./` is assumed. A `SyntaxError` is thrown otherwise.

The pattern is resolved relative to the file containing the `import` statement.

### Import members

Identifiers are generated for all matches. Any [common path
prefix](https://github.com/novemberborn/common-path-prefix) is removed, as is
any [common (compound)
extension](https://github.com/novemberborn/common-extname). File-separators in
the resulting strings are replaced by dollar signs. The directory components are
then [converted into identifiers](https://github.com/novemberborn/identifierfy).

A valid identifier cannot always be generated. If that's the case a
`SyntaxError` is thrown with more details. Similarly multiple matches may result
in the same identifier. This also results in a `SyntaxError` being thrown.

For the `templates` example above the matches are:

* `templates/main.handlebars.js`
* `templates/_partial.handlebars.js`

Both matches share `templates/` as their path prefix, and `.handlebars.js` as
their extension. These strings are removed, resulting in `main` and `_partial`.
These are valid identifiers and therefore used as the import members.

A `SyntaxError` is throw when importing a member that does not correspond to a
match:

```js
import { doesNotExist } from './templates/*.handlebars.js' // This will throw a SyntaxError
```

Here's an overview of how the members are determined for additional matches.
Assume `templates/` is the common path prefix and `.handlebars.js` the common
extension:

Match|Result|Reason
:---|:---|:---
`templates/terms-and-conditions.handlebars.js`|`termsAndConditions`|The `-` cannot be used in the identifier so it's removed. The following character is uppercased
`templates/blog/footer.handlebars.js`|`blog$footer`|The `blog` directory wasn't removed so is joined with the `footer` name using a dollar sign
`templates/-main.handlebars.js`|`SyntaxError`|The `-` is removed, resulting in the same identifier as for `main.handlebars.js`
`templates/new.handlebars.js`|`_new`|`new` is a reserved word so it's prefixed with an underscore
`templates/blog/new.handlebars.js`|`blog$new`|Even though `new` is a reserved word, it's combined with `blog$` so no prefix is necessary
`templates/404.handlebars.js`|`_404`|Identifiers can't start with digits so it's prefixed with an underscore
`templates/error-pages/404.handlebars.js`|`errorPages$404`|Now that `404` is combined with `errorPages$` it no longer needs to be prefixed
`templates/🙊.handlebars.js`|`SyntaxError`|No identifier can be generated for `🙊`
