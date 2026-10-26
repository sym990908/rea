/* One pause/play control for every animated figure (contract: proposals/pause-control.md; look: .fig-pause in revision.css).
 * Loaded synchronously in <head>, so each figure's inline script can call FigurePause.attach() as it runs.
 * The control only reports the reader's choice; each figure stops and resumes its own loop in pause()/play(). */
(function () {
  'use strict';
  if (window.FigurePause) return;
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  // Deliberate: once a reader pauses any figure, figures that start animating later start paused too.
  // It lasts for this page view only. A plain variable, never written to storage.
  var held = false;
  var ICON = {
    pause: '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><rect x="2.3" y="1.8" width="2.5" height="8.4" rx=".6"/><rect x="7.2" y="1.8" width="2.5" height="8.4" rx=".6"/></svg>',
    play: '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3.2 2.1v7.8c0 .45.5.72.87.47l5.9-3.9a.56.56 0 0 0 0-.94L4.07 1.63a.56.56 0 0 0-.87.47z"/></svg>'
  };

  // FigurePause.attach(figure, {name, host, before, still, pause(), play()}) -> control
  function attach(fig, o) {
    o = o || {};
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'fig-pause';
    b.setAttribute('aria-label', 'Pause animation' + (o.name ? ' (' + o.name + ')' : ''));
    var ctl = {
      button: b,
      paused: false,
      // Ask at the moment the figure would start animating.
      startsPaused: function () { return held || (!!o.still && reduced.matches); },
      // Show a state without calling pause()/play(): for changes the figure makes itself.
      set: function (p) {
        ctl.paused = !!p;
        b.setAttribute('aria-pressed', ctl.paused ? 'true' : 'false');
        b.innerHTML = (ctl.paused ? ICON.play : ICON.pause) + '<span>' + (ctl.paused ? 'Play' : 'Pause') + '</span>';
        return ctl;
      },
      // Hide it once nothing is left to pause (a one-shot that has finished, a tour the reader took over).
      show: function (on) { b.hidden = on === false; return ctl; }
    };
    b.addEventListener('click', function () {
      if (ctl.paused) { ctl.set(false); if (o.play) o.play(); }
      else { held = true; ctl.set(true); if (o.pause) o.pause(); }
    });
    ctl.set(o.paused != null ? o.paused : ctl.startsPaused());
    if (o.before && o.before.parentNode) o.before.parentNode.insertBefore(b, o.before);
    else (o.host || fig).appendChild(b);
    return ctl;
  }

  window.FigurePause = { attach: attach, reduced: reduced, get held() { return held; } };
})();
