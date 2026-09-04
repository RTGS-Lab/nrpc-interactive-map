// Demo login panel. A FRONT DOOR, NOT ACCESS CONTROL.
//
// The site is static nginx with no server-side code, so nothing here can be
// enforced: every asset is public, and anyone can read this file. What it
// does is put a sign-in card over the map so a forwarded link opens on a
// "draft demo" framing rather than straight into the planner, and so the
// person opening it has to type demo / demo once. Remembered in localStorage
// so a phone does not ask again on every visit.
//
// The layout toggle rides on mobile.js's own `?mobile=1` / `?mobile=0` URL
// override: picking Desktop or Mobile reloads with that flag set, Auto strips
// it and lets the media query decide. The choice is not remembered — it is
// a per-visit switch, which is what a demo on someone else's laptop needs.
//
// To remove: delete the <script> line in index.html. To hide the hint that
// prints the credentials on the card, set SHOW_HINT = false.
(function () {
  "use strict";
  var USER = "demo";
  var PASS = "demo";
  var SHOW_HINT = true;
  var STORAGE_KEY = "nrpc-demo-login";
  if (/[?&]demo-logout(=|&|$)/.test(location.search)) {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
  try { if (localStorage.getItem(STORAGE_KEY) === "ok") return; } catch (e) {}

  var css = "" +
    "#demo-login{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;" +
      "padding:16px;padding-top:calc(16px + env(safe-area-inset-top));padding-bottom:calc(16px + env(safe-area-inset-bottom));" +
      "background:rgba(245,247,249,.92);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
      "font-family:'Avenir Next','Helvetica Neue',Helvetica,Arial,sans-serif;color:#323232}" +
    "#demo-login form{width:100%;max-width:360px;background:#fff;border:1px solid #d5d8dc;border-radius:8px;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.18);padding:28px 26px 22px;box-sizing:border-box}" +
    "#demo-login h1{margin:0 0 4px;font-size:18px;font-weight:600;letter-spacing:.01em}" +
    "#demo-login .sub{margin:0 0 20px;font-size:13px;color:#6a6f75;line-height:1.4}" +
    "#demo-login label{display:block;font-size:12px;font-weight:600;color:#55595e;margin:0 0 5px;text-transform:uppercase;letter-spacing:.04em}" +
    "#demo-login input{display:block;width:100%;box-sizing:border-box;height:42px;padding:0 12px;margin:0 0 14px;" +
      "font:16px inherit;font-family:inherit;border:1px solid #c4c8cd;border-radius:4px;background:#fff;color:#323232}" +
    "#demo-login input:focus{outline:none;border-color:#0079c1;box-shadow:0 0 0 3px rgba(0,121,193,.18)}" +
    "#demo-login button{display:block;width:100%;height:42px;margin-top:6px;border:0;border-radius:4px;" +
      "background:#0079c1;color:#fff;font:16px inherit;font-family:inherit;font-weight:600;cursor:pointer}" +
    "#demo-login button:hover{background:#00639f}" +
    "#demo-login .seg{display:flex;border:1px solid #c4c8cd;border-radius:4px;overflow:hidden;margin:0 0 16px}" +
    "#demo-login .seg label{flex:1;margin:0;padding:0;text-transform:none;letter-spacing:0;font-size:14px;font-weight:500;" +
      "color:#55595e;text-align:center;line-height:38px;cursor:pointer;border-left:1px solid #c4c8cd;background:#fff}" +
    "#demo-login .seg label:first-child{border-left:0}" +
    "#demo-login .seg label:has(input:checked){background:#0079c1;color:#fff}" +
    "#demo-login .seg label:has(input:focus-visible){box-shadow:inset 0 0 0 2px rgba(0,121,193,.45)}" +
    "#demo-login .seg input{position:absolute;opacity:0;width:0;height:0;margin:0}" +
    "#demo-login .err{min-height:18px;margin:10px 0 0;font-size:13px;color:#b3261e;text-align:center}" +
    "#demo-login .hint{margin:14px 0 0;font-size:12px;color:#8a8f95;text-align:center}" +
    "#demo-login .hint code{font-family:Menlo,Consolas,monospace;color:#55595e}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var root = document.createElement("div");
  root.id = "demo-login";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "demo-login-title");
  root.innerHTML =
    '<form autocomplete="off" novalidate>' +
      '<h1 id="demo-login-title">NRPC Parcel Report Planner</h1>' +
      '<p class="sub">Draft demo. Sign in to open the planner. Parcel data shown is unverified.</p>' +
      '<label for="demo-user">Username</label>' +
      '<input id="demo-user" name="username" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus>' +
      '<label for="demo-pass">Password</label>' +
      '<input id="demo-pass" name="password" type="password">' +
      '<label>Open as</label>' +
      '<div class="seg" role="radiogroup" aria-label="Layout">' +
        '<label><input type="radio" name="layout" value="auto">Auto</label>' +
        '<label><input type="radio" name="layout" value="0">Desktop</label>' +
        '<label><input type="radio" name="layout" value="1">Mobile</label>' +
      '</div>' +
      '<button type="submit">Sign in</button>' +
      '<p class="err" aria-live="polite"></p>' +
      (SHOW_HINT ? '<p class="hint">Demo credentials: <code>demo</code> / <code>demo</code></p>' : "") +
    "</form>";
  document.body.appendChild(root);

  var user = root.querySelector("#demo-user");
  var pass = root.querySelector("#demo-pass");
  var err  = root.querySelector(".err");

  // Preselect whatever the URL already says, else Auto.
  var cur = /[?&]mobile=([01])/.exec(location.search);
  var want = cur ? cur[1] : "auto";
  root.querySelector('input[name="layout"][value="' + want + '"]').checked = true;

  function urlFor(choice) {
    var params = location.search.replace(/^\?/, "").split("&").filter(function (kv) {
      return kv && !/^mobile=/.test(kv) && !/^demo-logout(=|$)/.test(kv);
    });
    if (choice !== "auto") params.push("mobile=" + choice);
    return location.pathname + (params.length ? "?" + params.join("&") : "") + location.hash;
  }
  root.querySelector("form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (user.value.trim().toLowerCase() === USER && pass.value === PASS) {
      try { localStorage.setItem(STORAGE_KEY, "ok"); } catch (e) {}
      var choice = root.querySelector('input[name="layout"]:checked').value;
      if (choice !== want) {
        // mobile.js read its override at boot; a different choice needs a
        // reload. The card will not come back: the login is stored.
        location.replace(urlFor(choice));
        return;
      }
      root.remove();
      style.remove();
      return;
    }
    err.textContent = "That did not match. Try demo / demo.";
    pass.value = "";
    pass.focus();
  });
  setTimeout(function () { user.focus(); }, 0);
})();
