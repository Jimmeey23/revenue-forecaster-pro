const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

function makeReq(payload) {
  const req = new EventEmitter();
  req.method = 'POST';
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
      this.done(JSON.parse(body));
    },
    wait() {
      return new Promise(resolve => {
        this.done = resolve;
      });
    }
  };
}

async function testManagementReadoutNormalizesRevenueUnits() {
  process.env.DEEPSEEK_API_KEY = 'test-key';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: 'Sales increased 5% month over month to 2.02 million, driven by session revenue growth of 19% to 1.73 million.'
        }
      }]
    })
  });

  delete require.cache[require.resolve('../api/management-readout.js')];
  const handler = require('../api/management-readout.js');
  const res = makeRes();
  const done = res.wait();
  await handler(makeReq({
    studio: 'Kwality House',
    month: 'April 2026',
    current: { sales: 2020000, sessionRevenue: 1730000 },
    previous: { sales: 1920000, sessionRevenue: 1450000 }
  }), res);
  const body = await done;
  const text = body.lines.join(' ');
  assert(!/\bmillion\b/i.test(text), `readout should not contain million: ${text}`);
  assert(text.includes('₹20.2L'), `readout should include formatted sales value: ${text}`);
  assert(text.includes('₹17.3L'), `readout should include formatted session value: ${text}`);
}

async function testOpenAiChatHandlerContracts() {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;
  const originalFetch = global.fetch;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete require.cache[require.resolve('../api/openai-chat.js')];
  const handler = require('../api/openai-chat.js');

  const missingRes = makeRes();
  const missingDone = missingRes.wait();
  await handler(makeReq({ question: 'What changed?', context: { studio: 'Supreme HQ' } }), missingRes);
  const missingBody = await missingDone;
  assert.strictEqual(missingRes.statusCode, 503, 'OpenAI chat should return setup status when no key exists');
  assert(/OPENAI_API_KEY/.test(missingBody.error), 'missing-key response should mention OPENAI_API_KEY');

  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.strictEqual(url, 'https://api.openai.com/v1/responses', 'chat should call the OpenAI Responses API');
    assert.strictEqual(body.model, 'gpt-5', 'chat should default to GPT-5');
    assert(body.instructions.includes('Physique 57 India'), 'chat instructions should keep the P57 operations role');
    assert(body.input.includes('Supreme HQ'), 'chat request should include dashboard context');
    return {
      ok: true,
      json: async () => ({ output_text: 'Sales are up because session revenue improved.' })
    };
  };
  const okRes = makeRes();
  const okDone = okRes.wait();
  await handler(makeReq({ question: 'Why are sales up?', context: { studio: 'Supreme HQ', month: 'July 2025' } }), okRes);
  const okBody = await okDone;
  assert.strictEqual(okRes.statusCode, 200, 'OpenAI chat should return generated answers');
  assert.strictEqual(okBody.model, 'gpt-5', 'OpenAI chat should expose the default model used');
  assert(okBody.answer.includes('session revenue'), 'OpenAI chat should return the model answer');

  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
  global.fetch = originalFetch;
}

function testDashboardContainsCachedTableInsightRefresh() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const managementApi = fs.readFileSync(path.join(__dirname, '..', 'api', 'management-readout.js'), 'utf8');
  const tableApi = fs.readFileSync(path.join(__dirname, '..', 'api', 'table-insight.js'), 'utf8');
  assert(html.includes('/api/table-insight'), 'dashboard should call the table insight API');
  assert(html.includes('function refreshTableInsights'), 'dashboard should define cached table insight refresh');
  assert(html.includes('tableInsightCacheKey'), 'dashboard should cache table insights by table data key');
  assert(html.includes('p57-ai-readout:v2'), 'management readout cache should be versioned after prompt upgrades');
  assert(html.includes('p57-table-insight:v2'), 'table insight cache should be versioned after prompt upgrades');
  assert(html.includes('ranked:{'), 'management readout payload should include ranked operating context');
  assert(html.includes('primaryAction'), 'management readout payload should include an action-oriented risk cue');
  assert(managementApi.includes('Do not merely restate metrics'), 'management prompt should require diagnosis beyond metric restatement');
  assert(managementApi.includes('Read:, Driver:, Demand:, Acquisition:, Retention:, Action:'), 'management prompt should require decision-oriented readout structure');
  assert(tableApi.includes('Do not just name the top row or restate the table'), 'table insight prompt should require interpretation beyond top-row restatement');
  assert(tableApi.includes('function tableContext'), 'table insight API should enrich payloads with table context');
}

function testDashboardTooltipAndCellDrillContracts() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(!/(^|\n)\s*\[data-tooltip\][^{]*::?before,[\s\S]{0,180}?display\s*:\s*none\s*!important/i.test(html), 'tooltip pseudo-elements should not be globally disabled');
  assert(html.includes('class="nav-icon"'), 'quick navigation should render icon markup');
  assert(html.includes('id="themeFloat"'), 'theme switcher should be a standalone top-right control');
  assert(!/<nav class="quick-nav"[\s\S]*data-action="theme"[\s\S]*<\/nav>/.test(html), 'theme switcher should not live inside quick navigation');
  assert(html.includes('id="tableTooltip"'), 'table info tooltip should render through a body-level portal');
  assert(html.includes('function showTableTooltip'), 'dashboard should position table tooltips with JavaScript');
  assert(html.includes('function cellDrillPayload'), 'dashboard should create context-aware cell drill payloads');
  assert(html.includes('data-cell-drill'), 'table cells should be marked as cell-level drill targets');
  assert(html.includes('Selected cell'), 'drill drawer should expose clicked-cell context');
}

function testDashboardSalesSourceDrillContracts() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const asset = fs.readFileSync(path.join(__dirname, '..', 'assets', 'sales-drill-index.js'), 'utf8');
  const rawAsset = fs.readFileSync(path.join(__dirname, '..', 'assets', 'raw-drill-index.js'), 'utf8');
  assert(html.includes('assets/sales-drill-index.js'), 'dashboard should load generated raw sales drill index');
  assert(html.includes('assets/raw-drill-index.js'), 'dashboard should load generated non-sales raw drill index');
  assert(asset.includes('window.SALES_DRILL_INDEX'), 'raw sales drill index should be exposed to dashboard code');
  assert(rawAsset.includes('window.RAW_DRILL_INDEX'), 'raw non-sales drill index should be exposed to dashboard code');
  assert(html.includes('function salesDrillRows'), 'dashboard should resolve source transaction rows for sales drill paths');
  assert(html.includes('function rawDrillRows'), 'dashboard should resolve source rows for non-sales drill paths');
  assert(html.includes('sourceRows'), 'drill payload should carry transaction source rows');
  assert(html.includes('Source transactions'), 'drill drawer should render source transaction rows');
  assert(html.includes("source:{kind:'category'"), 'sales category rows should define category source drill paths');
  assert(html.includes("source:{kind:'product'"), 'product rows should define product source drill paths');
  assert(html.includes("source:{kind:'sessionClass'"), 'class rows should define session source drill paths');
  assert(html.includes("source:{kind:'newSource'"), 'new-member source rows should define raw source drill paths');
  assert(html.includes("source:{kind:'leadSource'"), 'lead source rows should define CRM raw source drill paths');
  assert(html.includes("source:{kind:'lapsedMembership'"), 'churn rows should define lapsed membership raw source drill paths');
  assert(asset.includes('Memberships'), 'raw drill index should include membership category transaction paths');
  assert(asset.includes('Payment Value'), 'raw drill index should retain payment value context');
  assert(rawAsset.includes('sessionClass'), 'raw drill index should include session class paths');
  assert(rawAsset.includes('leadSource'), 'raw drill index should include lead source paths');
  assert(rawAsset.includes('lapsedMembership'), 'raw drill index should include lapsed membership paths');
}

function testDashboardQuickNavAutoCollapses() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert(html.includes('class="quick-nav is-collapsed"'), 'quick navigation should render collapsed by default');
  assert(/\.quick-nav\.is-collapsed:not\(:hover\):not\(:focus-within\)/.test(html), 'quick navigation should auto-expand on hover/focus and collapse after hover/focus leaves');
  assert(!html.includes('window.addEventListener(\'scroll\',expand') && !js.includes('window.addEventListener(\'scroll\',expand'), 'quick navigation should not stay expanded because of scroll-triggered expansion');
  assert(js.includes('jumpToSection(b.dataset.jump); b.blur();'), 'quick navigation should blur clicked buttons so it can auto-collapse after navigation');
  assert(html.includes('aria-label="Quick section navigation. Hover or focus to expand."'), 'quick navigation should describe expand behavior accessibly');
}

function testDashboardOpportunityChurnAndTrainerFooterContracts() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert(html.includes('id="businessOpportunityExplanation"'), 'growth opportunity queue should include an explanatory readout');
  assert(js.includes('Why flagged'), 'growth opportunity queue should explain why each row is selected');
  assert(js.includes('Next action'), 'growth opportunity queue should show recommended actions');
  assert(js.includes('Owner'), 'growth opportunity queue should show action ownership');
  assert(html.includes('id="churnRiskExplanation"'), 'churn table should explain churn-risk calculation and action logic');
  assert(html.includes("['Formula','Lapsed / expiring paid memberships']"), 'churn drill-down should expose the churn-risk formula');
  assert(html.includes('function churnAction'), 'dashboard should calculate churn action labels');
  assert(html.includes('function churnRiskBand'), 'dashboard should calculate churn risk bands');
  assert(html.includes('footerCells'), 'table helper should support explicit footer values');
  assert(html.includes('trainerFooter'), 'trainer scoreboard should use an explicit total footer');
  assert(html.includes('one(trainerTotals.pax/Math.max(trainerTotals.cls,1))'), 'trainer total Avg incl should be weighted attendance per class');
  assert(html.includes('one(trainerTotals.pax/Math.max(trainerTotals.active,1))'), 'trainer total Avg excl should be weighted attendance per active class');
}

function testDashboardDrillModalAndGrowthMovementContracts() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(html.includes('preferBasePrimary:true'), 'growth movement rows should promote metric breakdowns for value-cell drill-downs');
  assert(html.includes('supportLabel:\'Seven-month trend history\''), 'growth movement drill-downs should keep trend history as a separate support section');
  assert(html.includes('const useBasePrimary'), 'cell drill payloads should support base metric breakdowns as primary content');
  assert(html.includes('Metric breakdown'), 'drill-down context should label metric breakdowns clearly');
  assert(html.includes('drill-layout'), 'drill modal should use a structured layout wrapper');
  assert(html.includes('drill-card primary'), 'drill modal should visually distinguish primary drill content');
  assert(html.includes('Clicked-cell context'), 'drill modal should keep clicked-cell analytics visible');
  assert(html.includes('Selected row values'), 'drill modal should show selected row values as a distinct section');
  assert(html.includes('${drillAttr(kpiDrill(key,label))}'), 'summary insight cards should open KPI drill-downs');
}

function testDashboardRetentionWatchlistAndHeaderContracts() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(html.includes('id="riskWatchlistExplanation"'), 'retention risk watchlist should show a calculation note under the table');
  assert(html.includes('expiring paid memberships multiplied by churn rate'), 'risk watchlist note should explain exposed-lapse ranking');
  assert(html.includes('border-bottom:2px solid color-mix'), 'table headers should have a stronger bottom border');
  assert(html.includes('font-weight:1000!important'), 'table headers should be more bold');
}

function testDashboardCockpitHeaderContracts() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(html.includes('class="topbar cockpit-header"'), 'header should be the image-backed cockpit surface');
  assert(html.includes('<html lang="en" data-theme="light">'), 'dashboard should default to light mode');
  assert(html.includes("const THEME_STORE_KEY = 'p57-theme-v2';"), 'theme storage key should remain stable across default-mode changes');
  assert(html.includes('class="cockpit-controls"'), 'month selector and studio tabs should live in the cockpit header');
  assert(html.includes('class="cockpit-summary" id="cockpitSummary"'), 'cockpit should show an AI studio summary instead of metric cards');
  assert(!html.includes('id="dateStrong"'), 'cockpit should not render the active month badge in the title row');
  assert(!html.includes('id="networkCards"'), 'cockpit metric card container should be removed');
  assert(!html.includes('Studio performance with drill-down analytics behind every number.'), 'old hero headline should be removed');
  assert(html.includes('.cockpit-header,'), 'cockpit header should have dedicated styling');
  assert(html.includes('.hero{\n  display:none!important;'), 'old hero section should not render as a separate block');
  assert(html.includes('grid-template-areas:"title controls" "network network"'), 'cockpit brief should span the full hero width below the title/control row');
  assert(html.includes('grid-template-columns:minmax(0,1fr)!important;'), 'title row should not reserve space for the removed month badge');
  assert(html.includes('width:90%!important;'), 'dashboard should leave a little more side margin on desktop');
  assert(html.includes('width:100%!important;'), 'studio performance brief should use the full available cockpit width');
  assert(html.includes('grid-template-columns:repeat(2,minmax(0,1fr))!important'), 'location tabs should use a compact two-column control rail');
  assert(html.includes('min-height:54px!important;'), 'location tab buttons should use a larger touch target in the control rail');
  assert(html.includes('.cockpit-controls .select-wrap:hover'), 'cockpit month selector should keep its translucent background on hover');
  assert(html.includes('html[data-theme="light"] .cockpit-controls .select-wrap:hover'), 'light theme should not turn the cockpit month selector white on hover');
  assert(html.includes('backdrop-filter:blur(18px) saturate(132%)'), 'cockpit summary should use a restrained glassmorphic background');
  assert(html.includes('Studio performance brief') || fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').includes('Studio performance brief'), 'cockpit summary should use plain-English narrative labeling');
  assert(!html.includes('DeepSeek pending'), 'cockpit summary should not display a DeepSeek pending badge');
  assert(html.includes('function renderCockpitSummary'), 'cockpit summary should render from the AI readout pipeline');
  assert(html.includes('function cockpitSummaryText'), 'cockpit summary should compose a narrative paragraph');
  assert(html.includes('The clearest operating driver was'), 'cockpit summary should read like a plain-English performance narrative');
  assert(html.includes('renderCockpitSummary(lines);'), 'DeepSeek responses should update the cockpit summary');
  assert(html.includes("refreshAiReadout({force:true});"), 'studio/month changes should refresh AI readout data');
  assert(html.includes('const COCKPIT_IMAGES = ['), 'cockpit header should rotate through a curated image pool');
  assert(html.includes('--cockpit-image'), 'cockpit header image should be controlled by a CSS variable');
  assert(html.includes('function setRandomCockpitImage'), 'cockpit header should choose random images at runtime');
  assert(html.includes('window.setInterval(setRandomCockpitImage, 14000)'), 'cockpit header should keep changing images while the app is open');
  assert(html.includes('id="aiChatPanel"'), 'dashboard should render the GPT-5 chat panel');
  assert(html.includes('/api/openai-chat'), 'dashboard chat should call the local OpenAI route');
  assert(html.includes('function dashboardChatContext'), 'dashboard should build live context for AI chat');
  assert(html.includes('function bindAiChat'), 'dashboard should bind the AI chat interaction');
  assert(!html.includes("netCard('Studio sales'"), 'cockpit studio metric cards should be removed');
  assert(!html.includes("netCard('Network sales'"), 'cockpit network metric cards should remain removed');
  assert(html.includes("'assets/p57-cockpit-group.jpg'"), 'cockpit image pool should include the local group studio image');
  assert(html.includes("'assets/p57-cockpit-kettlebell.jpg'"), 'cockpit image pool should include the local kettlebell image');
  assert(html.includes("'assets/p57-cockpit-spin.jpg'"), 'cockpit image pool should include the local spin image');
  assert(!html.includes('hp-Img-1770172692.png'), 'cockpit image pool should not include removed images');
}

function testStudioHealthTrendPanelRefreshContracts() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert(html.includes('Net Sales') && html.includes('data-metric="salesRev"'), 'trend selector should use text labels instead of icons');
  assert(html.includes('Members') && html.includes('data-metric="buyers"'), 'trend selector should expose a clear members label');
  assert(html.includes('Transactions') && html.includes('data-metric="transactions"'), 'trend selector should expose a clear transactions label');
  assert(html.includes('Class Revenue') && html.includes('data-metric="sessionRev"'), 'trend selector should expose a clear class revenue label');
  assert(css.includes('grid-template-columns:minmax(0,65%) minmax(320px,35%)') || css.includes('grid-template-columns:minmax(0,3fr) minmax(280px,1fr)'), 'overview grid should allocate roughly 75% width to the chart and 25% to interpretations');
  assert(css.includes('.trend-bar-modern'), 'trend chart should define modern bar styling');
  assert(css.includes('.trend-row-label'), 'trend chart should define left-side month labels');
  assert(css.includes('.trend-benchmark-line'), 'trend chart should define a benchmark line');
  assert(js.includes('trend-bar-modern'), 'trend renderer should output modern bar markup');
  assert(js.includes('trend-row-label'), 'trend renderer should output left-side month labels');
  assert(js.includes('trend-benchmark-line'), 'trend renderer should output average benchmark markup');
}

(async () => {
  await testManagementReadoutNormalizesRevenueUnits();
  await testOpenAiChatHandlerContracts();
  testDashboardContainsCachedTableInsightRefresh();
  testDashboardTooltipAndCellDrillContracts();
  testDashboardSalesSourceDrillContracts();
  testDashboardQuickNavAutoCollapses();
  testDashboardOpportunityChurnAndTrainerFooterContracts();
  testDashboardDrillModalAndGrowthMovementContracts();
  testDashboardRetentionWatchlistAndHeaderContracts();
  testDashboardCockpitHeaderContracts();
  testStudioHealthTrendPanelRefreshContracts();
  console.log('Regression tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
