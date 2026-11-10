/**
 * Client half of youyou-window-drag.
 *
 * macOS DSH Desktop is a `hiddenInset` window with no native title bar, so the
 * only thing that can move it is a `-webkit-app-region: drag` box declared by
 * the page. The shell marks its chrome rows with `data-window-drag` and
 * `ui-web`'s base.css turns that mark into the darwin drag rule, but the same
 * base.css also marks every interactive box (button / link / input / [tabindex]
 * / ARIA widget) `no-drag`. Electron composes the draggable region from every
 * app-region box in document order, so a `no-drag` box that overlaps a chrome
 * row *after* that row subtracts the overlap; in this DOM enough of them land
 * on the chrome rows that what remains cannot drag the window.
 *
 * A plugin cannot reorder the shipped rows, but it can add one box after every
 * shipped box: a fixed band appended as the last child of <body>. Document
 * order is what decides composition, so this band wins along the window's top
 * edge no matter what the chrome rows still resolve to.
 *
 * Geometry: the band is BAND_HEIGHT tall and spans the full width. 16px stays
 * above the hiddenInset traffic lights (top 18px) and above the chrome rows'
 * first control row, so everything below it still receives clicks normally.
 * Only macOS desktop is touched: the `data-platform` marker is written by the
 * desktop preload and never exists in a browser, where a fixed top band would
 * just swallow clicks. Native fullscreen hides the band (a fullscreen window
 * cannot be moved anyway, and its top edge must stay clickable).
 */
window.__ModuleLoader__.load({
  id: 'youyou-window-drag',
  factory() {
    /** The band's element id; also the idempotence guard. */
    const BAND_ID = 'dsh-window-drag-band'
    /** Style element that owns the non-geometry rules (fullscreen + hover cue). */
    const STYLE_ID = 'dsh-window-drag-band-style'
    /** Height of the draggable strip, in CSS pixels, from the window's top edge. */
    const BAND_HEIGHT = 16
    /** Hover tint: only an affordance hint; the band is transparent at rest. */
    const HOVER_TINT = 'rgba(122, 155, 240, 0.12)'
    /** Written by the desktop preload on <html>; absent in every browser. */
    const PLATFORM_ATTR = 'data-platform'
    /** Set by the desktop shell while the window is in native fullscreen. */
    const FULLSCREEN_ATTR = 'data-fullscreen'

    /**
     * Whether this document is the macOS desktop renderer. The marker is the
     * preload's, so a Web GUI opened in a browser never qualifies.
     * @returns true when the top band is meaningful.
     */
    function isMacDesktop() {
      return document.documentElement?.dataset.platform === 'darwin'
    }

    /**
     * Install the stylesheet that owns fullscreen suppression and the hover
     * cue; the drag geometry itself is inline on the band.
     */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        `#${BAND_ID}{position:fixed;top:0;right:0;left:0;height:${BAND_HEIGHT}px;`,
        'z-index:2147483000;background:transparent;',
        'transition:background .12s ease;user-select:none}',
        `#${BAND_ID}:hover{background:${HOVER_TINT}}`,
        `html[${PLATFORM_ATTR}=darwin][${FULLSCREEN_ATTR}] #${BAND_ID}{display:none}`,
      ].join('')
      document.head.append(style)
    }

    /** Build the band element. Drag geometry is inline so it outranks base.css. */
    function createBand() {
      const band = document.createElement('div')
      band.id = BAND_ID
      band.setAttribute('aria-hidden', 'true')
      band.dataset.dshWindowDragBand = 'true'
      band.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'right:0',
        `height:${BAND_HEIGHT}px`,
        'z-index:2147483000',
        'background:transparent',
        // Inline: base.css subtracts `body > :not(#root)` and only the inline
        // declaration outranks that stylesheet rule.
        '-webkit-app-region:drag',
        'app-region:drag',
      ].join(';')
      return band
    }

    /**
     * Keep exactly one band, mounted last in <body>. Re-appending when a later
     * body child appears restores the document-order advantage; the resulting
     * mutation is a no-op because the band is last again.
     */
    function placeBand() {
      const body = document.body
      if (body === null) return
      if (!isMacDesktop()) {
        document.getElementById(BAND_ID)?.remove()
        return
      }
      ensureStyle()
      const band = document.getElementById(BAND_ID) ?? createBand()
      if (body.lastElementChild !== band) body.append(band)
    }

    /**
     * Arm the band for the lifetime of this Client run.
     * @param ctx - Cordis context of the Client half.
     */
    function apply(ctx) {
      ctx.effect(() => {
        let disposed = false
        let frame = 0

        /** Coalesce mounts and DOM bursts into one placement per frame. */
        const schedule = () => {
          if (disposed || frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            placeBand()
          })
        }

        // <body> child order: portals and overlays may appear after boot; the
        // band has to stay last for its document-order drag to win.
        const bodyObserver = new MutationObserver(schedule)
        const htmlObserver = new MutationObserver(schedule)

        const start = () => {
          if (disposed) return
          placeBand()
          bodyObserver.observe(document.body, { childList: true })
          htmlObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: [PLATFORM_ATTR, FULLSCREEN_ATTR],
          })
        }

        if (document.body === null) {
          document.addEventListener('DOMContentLoaded', start, { once: true })
        } else {
          start()
        }

        return () => {
          disposed = true
          if (frame !== 0) cancelAnimationFrame(frame)
          bodyObserver.disconnect()
          htmlObserver.disconnect()
          document.getElementById(BAND_ID)?.remove()
          document.getElementById(STYLE_ID)?.remove()
        }
      }, 'window-drag: top drag band')
    }

    return { inject: [], apply }
  },
})
