/* Accessible mobile nav toggle (shared by all pages).
   Visibility is driven by the button's aria-expanded state in CSS, so this
   script only flips that state and handles close-on-Esc / outside / link. */
(function () {
  "use strict";
  var btn = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (!btn || !nav) return;

  function setOpen(open) {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }

  function isOpen() {
    return btn.getAttribute("aria-expanded") === "true";
  }

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(!isOpen());
  });

  // Close when a link is chosen.
  nav.addEventListener("click", function (e) {
    if (e.target.closest("a")) setOpen(false);
  });

  // Close on Escape, returning focus to the button.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) { setOpen(false); btn.focus(); }
  });

  // Close on click outside the header.
  document.addEventListener("click", function (e) {
    if (isOpen() && !e.target.closest(".site .wrap")) setOpen(false);
  });
})();
