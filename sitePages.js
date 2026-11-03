const fs = require('fs');
const path = require('path');
const { pages, getPageStructuredData } = require('./public/js/site-pages');

const template = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPage(pageName) {
  const page = pages[pageName];
  const isAbout = pageName === 'about';
  let html = template.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeAttribute(page.title)}</title>`);
  const meta = {
    description: page.description,
    'og:title': page.title,
    'og:description': page.description,
    'og:url': page.url,
    'twitter:title': page.title,
    'twitter:description': page.description
  };
  for (const [name, value] of Object.entries(meta)) {
    const pattern = new RegExp(`(<meta (?:name|property)="${name}" content=")[^"]*("\\s*>)`);
    html = html.replace(pattern, (_, start, end) => start + escapeAttribute(value) + end);
  }
  html = html.replace(/(<link rel="canonical" href=")[^"]*(">)/, (_, start, end) => start + page.url + end);
  html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">${JSON.stringify(getPageStructuredData(pageName))}</script>`);
  if (isAbout) {
    html = html
      .replace('<main id="analysisPage" tabindex="-1">', '<main id="analysisPage" tabindex="-1" hidden>')
      .replace('<main id="aboutPage" class="about-page" tabindex="-1" hidden>', '<main id="aboutPage" class="about-page" tabindex="-1">')
      .replace('href="#analysisPage" id="skipLink"', 'href="#aboutPage" id="skipLink"')
      .replace('data-page="analysis" aria-current="page"', 'data-page="analysis"')
      .replace('data-page="about"', 'data-page="about" aria-current="page"');
  }
  return html;
}

module.exports = { renderPage };
