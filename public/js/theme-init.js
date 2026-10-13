// Runs before first paint (blocking, external so the CSP can stay strict) to avoid a light/dark flash.
(function () {
  var t = null;
  try { t = localStorage.getItem('carebridge.theme'); } catch (e) { /* storage blocked */ }
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' ? '#0A1317' : '#F3F6F7');
})();
