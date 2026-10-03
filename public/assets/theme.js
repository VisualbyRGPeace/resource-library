// Chạy sớm trong <head> để tránh nháy sáng/tối khi tải trang.
(function () {
  var t = null;
  try { t = localStorage.getItem('rl-theme'); } catch (e) {}
  if (!t) t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
})();
