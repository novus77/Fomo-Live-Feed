const CHROME_INSTALL_URL = 'https://github.com/novus77/Fomo-Live-Feed/releases/download/v0.3.0/Fomo-Live-Feed-v0.3.0-chrome.zip';

document.querySelectorAll('.install-link').forEach((link) => {
  link.href = CHROME_INSTALL_URL;
});

const revealItems = document.querySelectorAll('.reveal');

const demoTabs = document.querySelectorAll('[data-demo-tab]');
const demoPanels = document.querySelectorAll('[data-demo-panel]');

const activateDemoTab = (tab, moveFocus = false) => {
  const selectedPanel = tab.dataset.demoTab;

  demoTabs.forEach((item) => {
    const isSelected = item === tab;
    item.classList.toggle('active', isSelected);
    item.setAttribute('aria-selected', String(isSelected));
    item.tabIndex = isSelected ? 0 : -1;
  });

  demoPanels.forEach((panel) => {
    panel.hidden = panel.dataset.demoPanel !== selectedPanel;
  });

  if (moveFocus) tab.focus();
};

demoTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateDemoTab(tab));
  tab.addEventListener('keydown', (event) => {
    let nextIndex;

    if (event.key === 'ArrowRight') nextIndex = (index + 1) % demoTabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + demoTabs.length) % demoTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = demoTabs.length - 1;

    if (nextIndex !== undefined) {
      event.preventDefault();
      activateDemoTab(demoTabs[nextIndex], true);
    }
  });
});

if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries, observerInstance) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observerInstance.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add('is-visible'));
}
