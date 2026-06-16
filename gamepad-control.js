/*
 * gamepad-control.js
 * שכבת שליטה גנרית בבקר משחק (Xbox/PS/כל בקר standard) על ממשק HTML.
 * לא נוגע במקלדת/עכבר — רק מוסיף שכבה מקבילה.
 *
 * יכולות:
 *  - סטיק שמאלי / D-pad מזיזים סמן עכבר ויזואלי על המסך.
 *  - כפתור A (btn 0) עושה "קליק" על האלמנט שמתחת לסמן (elementFromPoint).
 *  - LB/RB (btn 4/5) או D-pad שמאל/ימין (btn 14/15) עוברים בין אלמנטים
 *    שניתן ללחוץ עליהם (כרטיסיות/טאבים + אלמנטים פוקוסביליים), עם focus ויזואלי.
 *
 * מודולרי וגנרי: לא תלוי במבנה ה-DOM הספציפי של אף פרויקט.
 * אם אין כרטיסיות/אלמנטים רלוונטיים בעמוד - חלק ה-tab cycling פשוט לא עושה כלום.
 */
(function () {
  'use strict';

  // ---------- הגדרות ----------
  var DEADZONE = 0.15;
  var MAX_SPEED = 18; // פיקסלים לפריים בהטיה מקסימלית
  var CURSOR_ID = 'gp-virtual-cursor';
  var FOCUS_CLASS = 'gp-focused';

  // ---------- מצב ----------
  var cursor = null;
  var cursorX = window.innerWidth / 2;
  var cursorY = window.innerHeight / 2;
  var rafId = null;

  // מצב כפתורים בפריים הקודם, לזיהוי edge (false -> true) לכל מקור בקר בנפרד
  // key: gamepad.index -> array of booleans
  var prevButtons = {};

  var focusIndex = -1;
  var focusEl = null;

  // ---------- סמן ויזואלי ----------
  function createCursor() {
    var el = document.createElement('div');
    el.id = CURSOR_ID;
    el.style.position = 'fixed';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.width = '22px';
    el.style.height = '22px';
    el.style.borderRadius = '50%';
    el.style.border = '2px solid #fff';
    el.style.background = 'rgba(80,160,255,0.55)';
    el.style.boxShadow = '0 0 6px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.3)';
    el.style.pointerEvents = 'none'; // לא חוסם קליקים אמיתיים מתחתיו
    el.style.zIndex = '2147483647';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    document.body.appendChild(el);
    return el;
  }

  function showCursor() {
    if (cursor) cursor.style.opacity = '1';
  }

  function moveCursorTo(x, y) {
    cursorX = Math.max(0, Math.min(window.innerWidth, x));
    cursorY = Math.max(0, Math.min(window.innerHeight, y));
    if (cursor) {
      cursor.style.left = cursorX + 'px';
      cursor.style.top = cursorY + 'px';
    }
  }

  // ---------- עזר: dead zone ----------
  function applyDeadzone(v) {
    if (Math.abs(v) < DEADZONE) return 0;
    // נרמול כדי שמחוץ ל-deadzone התנועה תתחיל מ-0 ולא תקפוץ
    var sign = v > 0 ? 1 : -1;
    return sign * (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
  }

  // ---------- קליק וירטואלי ----------
  function clickAtCursor() {
    var el = document.elementFromPoint(cursorX, cursorY);
    if (!el) return;
    // אירוע קליק "אמיתי" כדי שיתפוס listeners רגילים (addEventListener('click',...))
    var evt = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cursorX,
      clientY: cursorY
    });
    el.dispatchEvent(evt);
  }

  // ---------- ניווט בין אלמנטים (טאבים / פוקוסביליים) ----------
  function getNavigableElements() {
    // כל אלמנט "לחיץ" שמופיע בעמוד: טאבים נפוצים + אלמנטים פוקוסביליים סטנדרטיים.
    var selector = [
      '[data-chart]',
      '[data-cat]',
      '[data-co]',
      '[role="tab"]',
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[tabindex]'
    ].join(',');

    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    return nodes.filter(function (el) {
      if (el.id === CURSOR_ID) return false;
      if (el.hasAttribute('disabled')) return false;
      if (el.tabIndex === -1 && !el.matches('[data-chart],[data-cat],[data-co],[role="tab"]')) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    });
  }

  function clearFocusVisual() {
    if (focusEl) focusEl.classList.remove(FOCUS_CLASS);
  }

  function setFocusVisual(el) {
    clearFocusVisual();
    focusEl = el;
    if (focusEl) {
      focusEl.classList.add(FOCUS_CLASS);
      focusEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }

  function ensureFocusStyle() {
    if (document.getElementById('gp-focus-style')) return;
    var style = document.createElement('style');
    style.id = 'gp-focus-style';
    style.textContent =
      '.' + FOCUS_CLASS + '{' +
      'outline:3px solid #50a0ff !important;' +
      'outline-offset:2px !important;' +
      'box-shadow:0 0 10px rgba(80,160,255,0.8) !important;' +
      '}';
    document.head.appendChild(style);
  }

  function cycleFocus(direction) {
    var els = getNavigableElements();
    if (els.length === 0) return; // אין כרטיסיות/אלמנטים - לא עושים כלום

    if (focusIndex < 0 || focusIndex >= els.length || els[focusIndex] !== focusEl) {
      focusIndex = els.indexOf(focusEl);
    }
    if (focusIndex < 0) {
      focusIndex = direction > 0 ? 0 : els.length - 1;
    } else {
      focusIndex = (focusIndex + direction + els.length) % els.length;
    }
    setFocusVisual(els[focusIndex]);
  }

  function activateFocused() {
    if (focusEl) {
      focusEl.click();
    } else {
      clickAtCursor();
    }
  }

  // ---------- לולאת דגימה ----------
  function pollGamepads() {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];

    for (var i = 0; i < pads.length; i++) {
      var pad = pads[i];
      if (!pad || pad.mapping !== 'standard') continue;

      var buttons = pad.buttons;
      var axes = pad.axes;
      var prev = prevButtons[pad.index] || [];

      function pressed(idx) {
        return !!(buttons.length > idx && buttons[idx] && buttons[idx].pressed);
      }
      function justPressed(idx) {
        var now = pressed(idx);
        var was = !!prev[idx];
        return now && !was;
      }

      // --- תנועת סמן: סטיק שמאלי (axes 0/1) ---
      if (axes.length > 1) {
        var ax = applyDeadzone(axes[0]);
        var ay = applyDeadzone(axes[1]);
        if (ax !== 0 || ay !== 0) {
          showCursor();
          moveCursorTo(cursorX + ax * MAX_SPEED, cursorY + ay * MAX_SPEED);
        }
      }

      // --- תנועת סמן: D-pad (12=up,13=down,14=left,15=right) ---
      if (buttons.length > 15) {
        var dx = 0, dy = 0;
        if (pressed(12)) dy -= 1;
        if (pressed(13)) dy += 1;
        if (pressed(14)) dx -= 1;
        if (pressed(15)) dx += 1;
        if (dx !== 0 || dy !== 0) {
          showCursor();
          moveCursorTo(cursorX + dx * MAX_SPEED, cursorY + dy * MAX_SPEED);
        }
      }

      // --- כפתור A (btn 0): קליק על מה שמתחת לסמן ---
      if (buttons.length > 0 && justPressed(0)) {
        activateFocused();
      }

      // --- LB/RB (btn 4/5): מעבר בין כרטיסיות/אלמנטים ---
      if (buttons.length > 4 && justPressed(4)) {
        cycleFocus(-1);
      }
      if (buttons.length > 5 && justPressed(5)) {
        cycleFocus(1);
      }

      // --- D-pad שמאל/ימין (14/15) כתחליף ל-LB/RB למעבר כרטיסיות ---
      // (שימוש זה לא מתנגש עם תנועת הסמן - אותו לחיצה משרתת את שניהם)
      if (buttons.length > 14 && justPressed(14)) {
        cycleFocus(-1);
      }
      if (buttons.length > 15 && justPressed(15)) {
        cycleFocus(1);
      }

      // שמירת מצב כפתורים לפריים הבא (בלי לשמור reference ל-pad/buttons עצמם)
      var snapshot = [];
      for (var b = 0; b < buttons.length; b++) {
        snapshot[b] = !!(buttons[b] && buttons[b].pressed);
      }
      prevButtons[pad.index] = snapshot;
    }

    rafId = requestAnimationFrame(pollGamepads);
  }

  // ---------- אתחול ----------
  function init() {
    ensureFocusStyle();
    cursor = createCursor();
    moveCursorTo(cursorX, cursorY);
    if (rafId === null) {
      rafId = requestAnimationFrame(pollGamepads);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
