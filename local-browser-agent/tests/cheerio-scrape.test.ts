import assert from "node:assert/strict";
import test from "node:test";
import { scrapeHtml, selectScrapeMatch } from "../apps/server/src/scrape/cheerio-scrape.js";

const markup = `<!doctype html>
<html>
  <body>
    <section id="promos">
      <a class="promo card" href="/promo/one"><span>Promo One</span></a>
      <a class="promo card" data-testid="promo-two" href="/promo/two"><span>Promo Two</span></a>
      <a class="promo card" href="/promo/three"><span>Other Offer</span></a>
    </section>
  </body>
</html>`;

test("Cheerio scraper returns stable selectors and resolved links", () => {
  const result = scrapeHtml(markup, "https://example.test/base", {
    selector: ".promo",
    extract: ["text", "attributes", "href", "outerHTML"]
  });
  assert.equal(result.totalMatches, 3);
  assert.equal(result.filteredMatches, 3);
  const second = result.matches[1];
  assert.ok(second);
  assert.equal(second.position, 2);
  assert.equal(second.text, "Promo Two");
  assert.equal(second.href, "https://example.test/promo/two");
  assert.equal(second.selector, 'a[data-testid="promo-two"]');
  assert.match(second.outerHTML || "", /Promo Two/);
});

test("Cheerio scraper filters text before applying a 1-based position", () => {
  const match = selectScrapeMatch(markup, "https://example.test/", {
    selector: "a",
    containsText: "promo",
    position: 2,
    extract: ["text", "href"]
  });
  assert.equal(match.text, "Promo Two");
  assert.equal(match.position, 2);
});

test("Cheerio scraper reports missing positions and invalid selectors", () => {
  assert.throws(() => selectScrapeMatch(markup, "https://example.test/", {
    selector: ".promo",
    position: 9
  }), /position 9 does not exist/);
  assert.throws(() => scrapeHtml(markup, "https://example.test/", {
    selector: "["
  }), /Invalid Cheerio selector/);
});
