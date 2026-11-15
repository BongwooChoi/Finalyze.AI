/* Runs before paint; the original design remains available as the light theme. */
(() => {
  const root = document.documentElement;
  const key = 'finalyze-theme';
  let theme = 'terminal';
  try { if (localStorage.getItem(key) === 'classic') theme = 'classic'; } catch {}
  function apply(value) {
    theme = value === 'classic' ? 'classic' : 'terminal';
    root.dataset.theme = theme;
    root.dataset.bsTheme = theme === 'terminal' ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'terminal' ? '#0c1015' : '#2563eb');
    const button = document.getElementById('themeToggle');
    if (button) {
      button.textContent = theme === 'terminal' ? '라이트' : '터미널';
      button.setAttribute('aria-label', theme === 'terminal' ? '기존 라이트 디자인으로 전환' : '터미널 디자인으로 전환');
      button.setAttribute('aria-pressed', String(theme === 'terminal'));
    }
    if (window.Chart) Object.values(Chart.instances).forEach(chart => chart.update('none'));
  }
  apply(theme);
  document.addEventListener('DOMContentLoaded', () => {
    if (window.Chart) Chart.register({
      id: 'finalyzeTheme',
      beforeUpdate(chart) {
        const dark = root.dataset.theme === 'terminal';
        const color = dark ? '#b8c3d1' : '#666';
        const options = chart.config.options;
        options.color = color;
        for (const scale of Object.values(options.scales || {})) {
          scale.ticks = { ...scale.ticks, color };
          scale.title = { ...scale.title, color };
          scale.grid = { ...scale.grid, color: dark ? '#26313e' : '#e5e7eb' };
          scale.border = { ...scale.border, color: dark ? '#344152' : '#d1d5db' };
        }
        const plugins = options.plugins ||= {};
        for (const name of ['title', 'subtitle', 'datalabels']) {
          if (plugins[name] && plugins[name] !== false) plugins[name].color = color;
        }
        if (chart.canvas.id === 'incomeStatementChart' && plugins.datalabels) {
          // Keep dense values in tooltips on small screens instead of overlapping labels.
          plugins.datalabels.display = context => root.dataset.theme !== 'terminal' ? true : context.chart.width >= 440 ? 'auto' : false;
        }
        if (plugins.legend !== false) {
          plugins.legend ||= {};
          plugins.legend.labels = { ...plugins.legend.labels, color };
        }
      }
    });
    apply(theme);
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      apply(theme === 'terminal' ? 'classic' : 'terminal');
      try { localStorage.setItem(key, theme); } catch {}
    });
  });
})();
