(() => {
  "use strict";

  const header = document.querySelector(".site-header");
  const nav = document.querySelector(".site-nav");
  const toggle = document.querySelector(".nav-toggle");
  const firstLink = document.querySelector(".nav-links a");
  if (!header || !nav || !toggle || !firstLink) {
    console.error("Navigation could not initialize: required markup is missing.");
    return;
  }

  const mobile = window.matchMedia("(max-width: 760px)");
  let compactLayout = mobile.matches;
  let focusedNavItem = nav.contains(document.activeElement) ? document.activeElement : null;
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

  nav.addEventListener("focusin", (event) => {
    focusedNavItem = event.target;
  });
  nav.addEventListener("focusout", (event) => {
    if (nav.contains(event.relatedTarget)) return;
    // CSS may blur a hidden item before the media-query change event runs.
    if (mobile.matches === compactLayout || event.relatedTarget !== null) {
      focusedNavItem = null;
    }
  });

  mobile.addEventListener("change", () => {
    const hadNavFocus = nav.contains(document.activeElement) || focusedNavItem !== null;
    const hadToggleFocus = document.activeElement === toggle || focusedNavItem === toggle;
    compactLayout = mobile.matches;
    setOpen(false);
    if (mobile.matches && hadNavFocus) {
      toggle.focus();
    } else if (!mobile.matches && hadToggleFocus) {
      firstLink.focus();
    }
  });

  setOpen(false);
  header.classList.add("nav-ready");
})();

(() => {
  "use strict";

  const initialize = (carousel) => {
    const track = carousel.querySelector("[data-carousel-track], .testimonial-track");
    const controls = carousel.querySelector("[data-carousel-controls], .carousel-controls");
    const previous = carousel.querySelector("[data-carousel-previous]");
    const next = carousel.querySelector("[data-carousel-next]");
    const status = carousel.querySelector("[data-carousel-status], .carousel-status");
    if (!track || !controls || !previous || !next || !status) {
      console.error("Carousel could not initialize: required markup is missing.");
      return;
    }

    const slides = Array.from(track.querySelectorAll("[data-carousel-slide], .testimonial"));
    if (slides.length === 0) {
      console.error("Carousel could not initialize: no slides were found.");
      return;
    }
    const links = Array.from(carousel.querySelectorAll("[data-carousel-link]"));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const updateState = () => {
      const bounds = track.getBoundingClientRect();
      const visible = slides.filter((slide) => {
        const box = slide.getBoundingClientRect();
        const center = box.left + box.width / 2;
        return center >= bounds.left && center <= bounds.right;
      });
      if (visible.length > 0) {
        const first = slides.indexOf(visible[0]) + 1;
        const last = slides.indexOf(visible[visible.length - 1]) + 1;
        const text = `${first === last ? first : `${first}\u2013${last}`} of ${slides.length}`;
        if (status.textContent !== text) status.textContent = text;
        links.forEach((link) => {
          if (link.getAttribute("href") === `#${visible[0].id}`) {
            link.setAttribute("aria-current", "true");
          } else {
            link.removeAttribute("aria-current");
          }
        });
      }
      previous.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 2;
    };

    const goTo = (left) => {
      track.scrollTo({ left, behavior: reducedMotion.matches ? "auto" : "smooth" });
    };

    const move = (direction) => {
      const firstLeft = slides[0].getBoundingClientRect().left;
      const maximum = track.scrollWidth - track.clientWidth;
      // Clamp stops so the final partial page is reachable without duplicate slides.
      const stops = [...new Set(slides.map((slide) =>
        Math.min(maximum, Math.max(0, slide.getBoundingClientRect().left - firstLeft))
      ))];
      const destination = direction > 0
        ? stops.find((left) => left > track.scrollLeft + 2)
        : stops.reverse().find((left) => left < track.scrollLeft - 2);
      if (destination !== undefined) goTo(destination);
    };

    links.forEach((link) => {
      const slide = slides.find((item) => `#${item.id}` === link.getAttribute("href"));
      if (!slide) {
        console.error("Carousel link could not initialize: its slide is missing.");
        return;
      }
      link.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        goTo(slide.getBoundingClientRect().left - slides[0].getBoundingClientRect().left);
      });
    });

    previous.addEventListener("click", () => move(-1));
    next.addEventListener("click", () => move(1));
    track.addEventListener("keydown", (event) => {
      if (event.target !== track) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        move(event.key === "ArrowRight" ? 1 : -1);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        goTo(event.key === "Home" ? 0 : track.scrollWidth - track.clientWidth);
      }
    });

    let frame = 0;
    track.addEventListener("scroll", () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateState();
      });
    }, { passive: true });
    const resizeObserver = new ResizeObserver(updateState);
    resizeObserver.observe(track);

    controls.hidden = false;
    updateState();
  };

  document.querySelectorAll("[data-carousel], .testimonial-carousel").forEach(initialize);
})();
