module.exports = wrap
var cp = require('child_process')
var fs = require('fs')
var ChildProcess
var assert = require('assert')
var crypto = require('crypto')
var mkdirp = require('mkdirp')
var rimraf = require('rimraf')
var path = require('path')

var shim = '#!' + process.execPath + '\n' +
  fs.readFileSync(__dirname + '/shim.js')

var cmdShim = 'SETLOCAL\r\n' +
  'SET PATHEXT=%PATHEXT:;.JS;=;%\r\n' +
  process.execPath + ' "%~dp0\\.\\node" %*\r\n'

var isWindows = false
var pathRe = /^PATH=/
if (process.platform === 'win32' ||
  process.env.OSTYPE === 'cygwin' ||
  process.env.OSTYPE === 'msys') {
  pathRe = /^PATH=/i
  isWindows = true
}

var wrapMain = require.resolve('./wrap-main.js')

function wrap (argv, env, workingDir) {
  if (!ChildProcess) {
    // sure would be nice if the class were exposed...
    var child = cp.spawn('echo', [])
    ChildProcess = child.constructor
    child.kill('SIGKILL')
  }

  // if we're passed in the working dir, then it means that setup
  // was already done, so no need.
  var doSetup = !workingDir
  if (doSetup) {
    workingDir = setup(argv, env)
  }
  var spawn = ChildProcess.prototype.spawn

  function unwrap () {
    if (doSetup) {
      rimraf.sync(workingDir)
    }
    ChildProcess.prototype.spawn = spawn
  }

  ChildProcess.prototype.spawn = function (options) {
    var pathEnv
    var cmdi, c, re, match, exe

    // handle case where node/iojs is exec'd
    // this doesn't handle EVERYTHING, but just the most common
    // case of doing `exec(process.execPath + ' file.js')
    var file = path.basename(options.file)
    if (file === 'sh' || file === 'bash' || file === 'zsh') {
      cmdi = options.args.indexOf('-c')
      if (cmdi !== -1) {
        c = options.args[cmdi + 1]
        re = /^\s*((?:[^\=]*\=[^\=\s]*\s*)*)([^\s]+)/
        match = c.match(re)
        if (match) {
          exe = path.basename(match[2])
          if (exe === 'iojs' || exe === 'node') {
            c = c.replace(re, '$1' + exe)
            options.args[cmdi + 1] = c
          }
        }
      }
    } else if (isWindows && (
        file === path.basename(process.env.comspec) ||
        file === 'cmd.exe')) {
      cmdi = options.args.indexOf('/c')
      if (cmdi !== -1) {
        c = options.args[cmdi + 1]
        re = new RegExp('^\\s*"([^\\s]*(?:node|iojs)) ')
        match = c.match(re)
        if (match) {
          exe = path.basename(match[1]).replace(/\.exe$/, '')
          if (exe === 'node' || exe === 'iojs') {
            c = c.replace(re, exe + ' ')
            options.args[cmdi + 1] = c
          }
        }
      }
    } else if (file === 'node' || file === 'iojs') {
      options.file = workingDir + '/' + file
      options.args[0] = workingDir + '/' + file
    }

    for (var i = 0; i < options.envPairs.length; i++) {
      var ep = options.envPairs[i]
      if (ep.match(pathRe)) {
        pathEnv = ep.substr(5)
      }
    }
    var p = workingDir
    if (pathEnv) {
      p += ':' + pathEnv
    }
    options.envPairs.push('PATH=' + p)

    return spawn.call(this, options)
  }

  return unwrap
}

function setup (argv, env) {
  if (argv && typeof argv === 'object' && !env && !Array.isArray(argv)) {
    env = argv
    argv = []
  }

  if (!argv && !env) {
    throw new Error('at least one of "argv" and "env" required')
  }

  if (argv) {
    assert(Array.isArray(argv), 'argv must be array')
  } else {
    argv = []
  }

  if (env) {
    assert(typeof env === 'object', 'env must be an object')
  } else {
    env = {}
  }

  // For stuff like --use_strict or --harmony, we need to inject
  // the argument *before* the wrap-main.
  var execArgv = []
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].match(/^-/)) {
      execArgv.push(argv[i])
      if (argv[i] === '-r' || argv[i] === '--require') {
        execArgv.push(argv[++i])
      }
    } else {
      break
    }
  }
  if (execArgv.length) {
    if (execArgv.length === argv.length) {
      argv.length = 0
    } else {
      argv = argv.slice(execArgv.length)
    }
  }

  var settings = JSON.stringify({
    module: __filename,
    argv: argv,
    execArgv: execArgv,
    env: env,
    root: process.pid
  }, null, 2) + '\n'

  var workingDir = '/tmp/node-spawn-wrap-' + process.pid + '-' +
    crypto.randomBytes(6).toString('hex')

  process.on('exit', function () {
    rimraf.sync(workingDir)
  })

  mkdirp.sync(workingDir)
  workingDir = fs.realpathSync(workingDir)
  if (isWindows) {
    fs.writeFileSync(workingDir + '/node.cmd', cmdShim)
    fs.chmodSync(workingDir + '/node.cmd', '0755')
    fs.writeFileSync(workingDir + '/iojs.cmd', cmdShim)
    fs.chmodSync(workingDir + '/iojs.cmd', '0755')
  }
  fs.writeFileSync(workingDir + '/node', shim)
  fs.chmodSync(workingDir + '/node', '0755')
  fs.writeFileSync(workingDir + '/iojs', shim)
  fs.chmodSync(workingDir + '/iojs', '0755')
  fs.writeFileSync(workingDir + '/settings.json', settings)

  return workingDir
}
