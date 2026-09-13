(() => {
  "use strict";

  const header = document.querySelector(".site-header");
  const nav = document.querySelector(".site-nav");
  const toggle = document.querySelector(".nav-toggle");
  if (!header || !nav || !toggle) {
    console.error("Navigation could not initialize: required markup is missing.");
    return;
  }

  const mobile = window.matchMedia("(max-width: 760px)");
  const setOpen = (open) => {
    nav.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.querySelector(".menu-label").textContent = open ? "Close" : "Menu";
  };

  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });

  nav.addEventListener("click", (event) => {
    if (mobile.matches && event.target.closest("a")) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobile.matches && nav.dataset.open === "true") {
      setOpen(false);
      toggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (mobile.matches && nav.dataset.open === "true" && !header.contains(event.target)) {
      setOpen(false);
    }
  });

  mobile.addEventListener("change", () => {
    if (mobile.matches && nav.contains(document.activeElement)) {
      toggle.focus();
    }
    setOpen(false);
  });

  setOpen(false);
  header.classList.add("nav-ready");
})();
