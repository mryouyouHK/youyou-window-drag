/**
 * Headless smoke test for the youyou-window-drag Client module.
 *
 * No browser, no Electron, no new dependencies: client.js is a plain script that
 * only touches `window.__ModuleLoader__`, `document`, `requestAnimationFrame`,
 * `cancelAnimationFrame` and `MutationObserver`, so a vm sandbox with a tiny
 * fake DOM exercises it end to end.
 *
 * Covered:
 *  - the Client-module registration (`id`, lazy `factory`, `factory()` with no
 *    `require` argument, returned `{ inject: [], apply }` plugin shape, the
 *    `ctx.effect(callback, label)` lifetime);
 *  - macOS darwin: one band with the right id, inline drag declaration, mounted
 *    last in <body>, style element mounted in <head>;
 *  - a later <body> child: the band is re-appended last and never duplicated;
 *  - non-darwin: nothing is inserted and a darwin -> other-platform flip removes
 *    an existing band;
 *  - teardown: the effect disposer removes band + style, disconnects observers
 *    and cancels the pending animation frame.
 *
 * Run from the workspace root:
 *   node --test window-drag/test/client-smoke.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(HERE, '..', 'client.js')
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')

const MODULE_ID = 'youyou-window-drag'
const BAND_ID = 'dsh-window-drag-band'
const STYLE_ID = 'dsh-window-drag-band-style'

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------

/** A `style` object only ever assigned through `cssText` by the plugin. */
function createStyle() {
  return { cssText: '' }
}

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument
    this.tagName = String(tagName).toUpperCase()
    this.parentNode = null
    this.children = []
    this.id = ''
    this.textContent = ''
    this.attributes = new Map()
    this.style = createStyle()
    this.dataset = {}
  }

  get lastElementChild() {
    return this.children.length === 0 ? null : this.children[this.children.length - 1]
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode !== null) node.parentNode.detach(node)
      this.children.push(node)
      node.parentNode = this
    }
  }

  detach(node) {
    const index = this.children.indexOf(node)
    if (index !== -1) this.children.splice(index, 1)
    node.parentNode = null
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.detach(this)
  }

  setAttribute(name, value) {
    const text = String(value)
    this.attributes.set(String(name), text)
    if (name === 'id') this.id = text
  }

  getAttribute(name) {
    const value = this.attributes.get(String(name))
    return value === undefined ? null : value
  }

  walk(visit) {
    visit(this)
    for (const child of this.children) child.walk(visit)
  }
}

class FakeDocument {
  constructor({ platform, bodyPresent = true } = {}) {
    this.documentElement = new FakeElement(this, 'html')
    if (platform !== undefined) this.documentElement.dataset.platform = platform
    this.head = new FakeElement(this, 'head')
    this.documentElement.append(this.head)
    this.body = null
    this.listeners = new Map()
    if (bodyPresent) this.attachBody()
  }

  attachBody() {
    this.body = new FakeElement(this, 'body')
    this.documentElement.append(this.body)
    return this.body
  }

  createElement(tagName) {
    return new FakeElement(this, tagName)
  }

  getElementById(id) {
    let found = null
    this.documentElement.walk((element) => {
      if (found === null && element.id === id) found = element
    })
    return found
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatchEvent(type) {
    const listeners = this.listeners.get(type) ?? []
    this.listeners.delete(type)
    for (const listener of listeners) listener({ type })
  }
}

/** Number of elements carrying `id` in the whole document. */
function countById(document, id) {
  let count = 0
  document.documentElement.walk((element) => {
    if (element.id === id) count += 1
  })
  return count
}

// ---------------------------------------------------------------------------
// Sandbox: fake DOM + loader facade + frame/observer stubs
// ---------------------------------------------------------------------------

/**
 * Build one isolated environment and evaluate client.js inside it.
 * @param {{ platform?: string, bodyPresent?: boolean }} options - document setup.
 * @returns the sandbox, its fake document, captured registrations and drivers.
 */
function createEnvironment({ platform, bodyPresent = true } = {}) {
  const registrations = []
  const observers = []
  const frames = new Map()
  let nextFrameId = 0

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      this.disconnected = false
      observers.push(this)
    }

    observe(target, options) {
      assert.equal(this.disconnected, false, 'observe() after disconnect()')
      this.targets.push({ target, options })
    }

    disconnect() {
      this.disconnected = true
    }

    trigger() {
      if (!this.disconnected) this.callback([], this)
    }
  }

  const document = new FakeDocument({ platform, bodyPresent })

  const requestAnimationFrame = (callback) => {
    nextFrameId += 1
    frames.set(nextFrameId, callback)
    return nextFrameId
  }
  const cancelAnimationFrame = (id) => {
    frames.delete(id)
  }

  const window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }

  const sandbox = {
    window,
    document,
    requestAnimationFrame,
    cancelAnimationFrame,
    MutationObserver: FakeMutationObserver,
    console,
  }

  /** Drain queued animation frames (each callback may queue one more). */
  const flushFrames = () => {
    let guard = 0
    while (frames.size > 0) {
      guard += 1
      assert.ok(guard < 20, 'animation-frame callbacks keep rescheduling')
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback()
    }
  }

  /** Fire every live observer, as a real DOM mutation would. */
  const triggerObservers = () => {
    for (const observer of observers) observer.trigger()
  }

  return {
    sandbox,
    window,
    document,
    registrations,
    observers,
    frames,
    flushFrames,
    triggerObservers,
  }
}

/**
 * Evaluate client.js in the environment and materialize its plugin, then run
 * `apply(ctx)` with a fake Cordis context that mirrors `ctx.effect`.
 * @param {ReturnType<typeof createEnvironment>} env - environment to use.
 * @param {{ onEffect?: Function }} [hooks] - optional effect observer.
 * @returns the captured registration, plugin exports and recorded effects.
 */
function applyPlugin(env, hooks = {}) {
  vm.runInNewContext(CLIENT_SOURCE, env.sandbox, { filename: CLIENT_PATH })

  assert.equal(env.registrations.length, 1, 'client.js registers exactly one module factory')
  const registration = env.registrations[0]
  assert.equal(registration.id, MODULE_ID)

  // The loader always hands the factory a `require`; this plugin ignores it.
  // Calling it with no argument proves the bundle does not depend on it.
  const plugin = registration.factory()
  const effects = []

  const ctx = {
    effect(callback, label) {
      assert.equal(typeof callback, 'function', 'ctx.effect(callback, label)')
      assert.equal(typeof label, 'string')
      const disposer = callback()
      assert.equal(typeof disposer, 'function', 'effect callback returns a disposer')
      effects.push({ label, disposer })
      hooks.onEffect?.(effects.length - 1, label)
      const dispose = () => disposer()
      return dispose
    },
  }

  plugin.apply(ctx)
  return { registration, plugin, ctx, effects }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('registers the Client-module contract and mounts the darwin drag band', () => {
  const env = createEnvironment({ platform: 'darwin' })
  const root = env.document.createElement('div')
  root.id = 'root'
  env.document.body.append(root)

  const { registration, plugin, effects } = applyPlugin(env)

  // --- contract ---------------------------------------------------------
  assert.equal(typeof registration.factory, 'function')
  assert.deepEqual(Object.keys(registration).sort(), ['factory', 'id'])
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject'])
  // `inject` is created inside the vm realm, so compare its shape, not its
  // cross-realm Array prototype.
  assert.ok(Array.isArray(plugin.inject), 'inject is an array')
  assert.equal(plugin.inject.length, 0, 'the plugin injects no services')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(effects.length, 1, 'apply installs exactly one effect')
  assert.equal(effects[0].label, 'window-drag: top drag band')

  // --- band -------------------------------------------------------------
  const band = env.document.getElementById(BAND_ID)
  assert.ok(band, `#${BAND_ID} exists`)
  assert.equal(countById(env.document, BAND_ID), 1, 'exactly one band')
  assert.equal(band.tagName, 'DIV')
  assert.equal(band.parentNode, env.document.body)
  assert.equal(env.document.body.lastElementChild, band, 'band is the last element child of <body>')
  assert.equal(band.getAttribute('aria-hidden'), 'true')
  assert.equal(band.dataset.dshWindowDragBand, 'true')

  // Drag geometry must be inline: the shipped base.css rule
  // `html[data-platform=darwin] body>:not(#root)` sets no-drag on body children,
  // and only an inline declaration outranks it.
  assert.match(band.style.cssText, /(^|;)-webkit-app-region:drag(;|$)/, 'inline -webkit-app-region:drag')
  assert.match(band.style.cssText, /(^|;)app-region:drag(;|$)/, 'inline app-region:drag')
  assert.match(band.style.cssText, /(^|;)position:fixed(;|$)/)
  assert.match(band.style.cssText, /(^|;)height:16px(;|$)/)
  assert.match(band.style.cssText, /(^|;)background:transparent(;|$)/)

  // --- style element ----------------------------------------------------
  const style = env.document.getElementById(STYLE_ID)
  assert.ok(style, `#${STYLE_ID} exists`)
  assert.equal(style.tagName, 'STYLE')
  assert.equal(style.parentNode, env.document.head, 'style element is mounted in <head>')
  assert.equal(countById(env.document, STYLE_ID), 1)
  assert.match(style.textContent, new RegExp(`#${BAND_ID}\\{position:fixed`))
  assert.match(
    style.textContent,
    new RegExp(`html\\[data-platform=darwin\\]\\[data-fullscreen\\] #${BAND_ID}\\{display:none\\}`),
    'native fullscreen hides the band',
  )

  // The band is placed synchronously on activation; no frame is needed.
  assert.equal(env.frames.size, 0, 'no pending frame when <body> already existed')
})

test('the band is re-appended last and never duplicated when <body> grows', () => {
  const env = createEnvironment({ platform: 'darwin' })
  const root = env.document.createElement('div')
  root.id = 'root'
  env.document.body.append(root)

  applyPlugin(env)
  const band = env.document.getElementById(BAND_ID)
  assert.ok(band)

  // A portal (or another plugin) mounts a new direct child of <body> later.
  const portal = env.document.createElement('div')
  portal.id = 'portal'
  env.document.body.append(portal)
  assert.notEqual(env.document.body.lastElementChild, band, 'band is no longer last before the observer runs')

  // The body MutationObserver schedules one frame; that frame restores order.
  assert.ok(env.observers.length >= 2, 'body and html observers are installed')
  env.triggerObservers()
  assert.equal(env.frames.size, 1, 'placement is coalesced into one frame')
  env.flushFrames()

  assert.equal(env.document.getElementById(BAND_ID), band, 'the same band element is reused')
  assert.equal(env.document.body.lastElementChild, band, 'band is last again')
  assert.equal(countById(env.document, BAND_ID), 1, 'placing twice keeps exactly one band')
  assert.equal(env.document.body.children.indexOf(portal) >= 0, true)

  // A second pass with no new mutation is a no-op.
  env.triggerObservers()
  env.flushFrames()
  assert.equal(countById(env.document, BAND_ID), 1)
  assert.equal(env.document.getElementById(BAND_ID), band)
  assert.equal(env.document.body.lastElementChild, band)
})

test('inserts nothing outside the macOS desktop (darwin) renderer', () => {
  for (const platform of ['linux', 'win32', 'webkit', undefined]) {
    const env = createEnvironment({ platform })
    const root = env.document.createElement('div')
    root.id = 'root'
    env.document.body.append(root)

    const { effects } = applyPlugin(env)
    env.flushFrames()
    env.triggerObservers()
    env.flushFrames()

    assert.equal(env.document.getElementById(BAND_ID), null, `no band for platform ${String(platform)}`)
    assert.equal(env.document.getElementById(STYLE_ID), null, `no style for platform ${String(platform)}`)
    assert.deepEqual(env.document.body.children.map((element) => element.id), ['root'])
    assert.equal(effects.length, 1)
    effects[0].disposer()
  }
})

test('a darwin -> other-platform flip removes the band and is reversible', () => {
  const env = createEnvironment({ platform: 'darwin' })
  applyPlugin(env)
  assert.ok(env.document.getElementById(BAND_ID))

  // The desktop preload only writes `darwin`; the attribute can disappear when
  // the page is re-used by a carrier that does not mark the platform.
  delete env.document.documentElement.dataset.platform
  env.triggerObservers()
  env.flushFrames()
  assert.equal(env.document.getElementById(BAND_ID), null, 'band removed when the platform marker disappears')
  assert.ok(env.document.getElementById(STYLE_ID), 'style element is only removed by teardown')

  env.document.documentElement.dataset.platform = 'darwin'
  env.triggerObservers()
  env.flushFrames()
  assert.ok(env.document.getElementById(BAND_ID), 'band returns when the darwin marker returns')
  assert.equal(countById(env.document, BAND_ID), 1)
})

test('waits for DOMContentLoaded when <body> does not exist yet', () => {
  const env = createEnvironment({ platform: 'darwin', bodyPresent: false })
  applyPlugin(env)
  env.flushFrames()
  assert.equal(env.document.getElementById(BAND_ID), null, 'nothing mounts before <body> exists')

  const body = env.document.attachBody()
  const root = env.document.createElement('div')
  root.id = 'root'
  body.append(root)
  env.document.dispatchEvent('DOMContentLoaded')
  env.flushFrames()

  assert.ok(env.document.getElementById(BAND_ID), 'band mounts once the body exists')
  assert.equal(body.lastElementChild, env.document.getElementById(BAND_ID))
})

test('the effect disposer tears down band, style, observers and pending frame', () => {
  const env = createEnvironment({ platform: 'darwin' })
  const { effects } = applyPlugin(env)
  assert.ok(env.document.getElementById(BAND_ID))
  assert.ok(env.document.getElementById(STYLE_ID))
  assert.ok(env.observers.length >= 2)
  assert.ok(env.observers.every((observer) => !observer.disconnected))

  // Queue a frame first so teardown has something to cancel.
  const portal = env.document.createElement('div')
  env.document.body.append(portal)
  env.triggerObservers()
  assert.equal(env.frames.size, 1)

  effects[0].disposer()

  assert.equal(env.document.getElementById(BAND_ID), null, 'band removed')
  assert.equal(env.document.getElementById(STYLE_ID), null, 'style removed')
  assert.equal(env.frames.size, 0, 'pending placement frame cancelled')
  assert.ok(env.observers.every((observer) => observer.disconnected), 'observers disconnected')

  // A late mutation after teardown must not resurrect anything.
  env.triggerObservers()
  env.flushFrames()
  assert.equal(env.document.getElementById(BAND_ID), null)
  assert.equal(env.document.getElementById(STYLE_ID), null)
})
