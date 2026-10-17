import { test, expect } from '@playwright/test';
import { catalogs } from '../../gemini/lib/catalog.js';
import { inputs, resultFixture } from '../fixtures.js';

for (const type of ['injury', 'disability']) {
  const path = type === 'injury' ? '/analyst.lintsing.net/' : '/appraise.lintsing.net/';
  async function open(page) {
    await page.route('**/api/health/ready', route => route.fulfill({ json: { status: 'ready' } }));
    await page.route('**/api/standards/**', route => route.fulfill({ json: catalogs[type] }));
    await page.goto(path);
  }
  test(`${type}: no external CDN dependency, responsive layout and searchable official clauses`, async ({ page }) => {
    const hosts = new Set(); const errors = [];
    page.on('request', request => hosts.add(new URL(request.url()).hostname));
    page.on('pageerror', error => errors.push(error.message));
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(type === 'injury' ? '伤情程度评估' : '伤残等级评估');
    await expect(page.getByText('服务已连接')).toBeVisible();
    await page.getByRole('tab', { name: '标准条款' }).click();
    await page.getByRole('textbox', { name: '搜索标准条款' }).fill(type === 'injury' ? '5.9.4.f' : '脾部分切除');
    await expect(page.locator('.standard-row')).toHaveCount(1);
    await expect(page.locator('.standard-row')).toContainText(type === 'injury' ? '轻伤二级' : '九级伤残');
    expect([...hosts]).toEqual(['127.0.0.1']); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/${type}-${test.info().project.name}-standards.png`, fullPage: true });
  });
  test(`${type}: failures never create mock results, then successful results can be saved and reopened`, async ({ page }) => {
    let count = 0;
    await page.route('**/api/analyze', route => {
      count++;
      if (count === 1) return route.fulfill({ status: 503, headers: { 'x-request-id': 'failed-request-test' }, json: { error: { message: '当前分析模型不可用。' } } });
      const result = resultFixture(type);
      result.facts[0] = { ...result.facts[0], source: 'image', sourceRefs: [
        { source: 'image', sourceId: 'image-1', evidence: result.facts[0].evidence },
        { source: 'image', sourceId: 'image-2', evidence: result.facts[0].evidence },
      ] };
      return route.fulfill({ json: { result } });
    });
    await open(page);
    await page.getByRole('textbox', { name: '病历与检查记录' }).fill(inputs[type].description);
    await page.getByRole('button', { name: '开始评估' }).click();
    await expect(page.getByRole('alert')).toContainText('模型不可用');
    await expect(page.getByRole('heading', { name: '本次评估未完成' })).toBeVisible();
    await expect(page.locator('.result-failed')).toContainText('failed-request-test');
    expect(await page.evaluate(kind => localStorage.getItem(`appraisal_${kind}_history_v2`), type)).toBeNull();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('.conclusion h3')).toHaveText(`初步考虑：${type === 'injury' ? '轻伤二级' : '九级伤残'}`);
    await expect(page.locator('.fact-list')).toContainText('图片1');
    await expect(page.locator('.fact-list')).toContainText('图片2');
    await page.getByRole('button', { name: '保存到本机', exact: true }).click();
    await page.getByRole('tab', { name: /本机记录/ }).click();
    await expect(page.locator('.history-row')).toHaveCount(1);
    await page.locator('.history-row').click();
    await expect(page.locator('.report')).toBeVisible();
    await expect(page.locator('.fact-list')).toContainText('图片1');
    await expect(page.locator('.fact-list')).toContainText('图片2');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载报告' }).click();
    expect((await download).suggestedFilename()).toContain(type);
    await page.screenshot({ path: `test-results/${type}-${test.info().project.name}-result.png`, fullPage: true });
  });
  test(`${type}: insufficiency remains explicit and damaged history cannot cause a blank page`, async ({ page }) => {
    await page.addInitScript(kind => { localStorage.setItem(`appraisal_${kind}_history_v2`, '{broken'); localStorage.setItem(kind === 'injury' ? 'injury_history' : 'disability_history', '{broken'); }, type);
    await page.route('**/api/analyze', route => route.fulfill({ json: { result: resultFixture(type, {
      status: 'insufficient', grade: null, references: [], missingMaterials: ['补充明确的影像报告及复查记录'],
    }) } }));
    await open(page);
    await page.getByRole('textbox', { name: '病历与检查记录' }).fill('腿疼，资料不完整。');
    await page.getByRole('button', { name: '开始评估' }).click();
    await expect(page.locator('.conclusion h3')).toHaveText('暂不输出等级');
    await expect(page.locator('.missing-materials')).toContainText('补充明确的影像报告');
    await page.getByRole('tab', { name: '本机记录' }).click();
    await expect(page.getByText('旧版记录可能包含模拟结果，未纳入已核对记录。')).toBeVisible();
    await expect(page.getByText('暂无已保存的评估记录')).toBeVisible();
  });
  test(`${type}: contradictory facts remain visible and force a review status`, async ({ page }) => {
    const result = resultFixture(type);
    result.status = 'needs_review'; result.grade = null; result.requiresReview = true;
    result.facts = [
      { ...result.facts[0], id: 'F1', certainty: 'conflicted', assertedCertainty: 'uncertain', evidence: '报告甲疑似肋骨骨折' },
      { ...result.facts[0], id: 'F2', certainty: 'conflicted', assertedCertainty: 'excluded', evidence: '报告乙未见肋骨骨折' },
    ];
    result.conflicts = [{ factIds: ['F1', 'F2'], reason: '同一事实存在相互矛盾的来源记载，需人工复核。' }];
    await page.route('**/api/analyze', route => route.fulfill({ json: { result } }));
    await open(page);
    await page.getByRole('textbox', { name: '病历与检查记录' }).fill(inputs[type].description);
    await page.getByRole('button', { name: '开始评估' }).click();
    await expect(page.locator('.status-label.needs_review')).toContainText('需复核');
    await expect(page.locator('.conflicts-section')).toContainText('相互矛盾');
    await expect(page.locator('.fact-list')).toContainText('存在冲突');
    await expect(page.locator('.conclusion h3')).toHaveText('暂不输出等级');
  });
  test(`${type}: cancelling a pending request cannot display a late result`, async ({ page }) => {
    await page.route('**/api/analyze', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.fulfill({ json: { result: resultFixture(type) } }).catch(() => {}); });
    await open(page);
    await page.evaluate(() => { crypto.randomUUID = undefined; });
    await page.getByRole('textbox', { name: '病历与检查记录' }).fill(inputs[type].description);
    await page.getByRole('button', { name: '开始评估' }).click();
    await expect(page.getByRole('heading', { name: '正在核对材料与条款' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '暂无评估结果' })).toHaveCount(0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('已取消');
    await expect(page.locator('.result-failed')).toContainText('已取消');
    await page.waitForTimeout(1650);
    await expect(page.locator('.conclusion')).toHaveCount(0);
  });
  test(`${type}: a disconnected request shows a retryable failure, not an empty result`, async ({ page }) => {
    await page.route('**/api/analyze', route => route.abort('failed'));
    await open(page);
    await page.getByRole('textbox', { name: '病历与检查记录' }).fill(inputs[type].description);
    await page.getByRole('button', { name: '开始评估' }).click();
    await expect(page.getByRole('alert')).toContainText('未能收到分析服务的响应');
    await expect(page.getByRole('heading', { name: '本次评估未完成' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    await expect(page.locator('.result-pending')).toHaveCount(0);
    await expect(page.locator('.conclusion')).toHaveCount(0);
  });
  test(`${type}: report pictures have correct encoded MIME, full previews and small-screen layout`, async ({ page }) => {
    let submitted;
    await page.route('**/api/analyze', route => {
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: { result: resultFixture(type) } });
    });
    await open(page);
    const picture = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 600;
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 900, 600);
      context.fillStyle = '#222'; context.font = '28px sans-serif';
      context.fillText('合成测试资料 / 非真实病历', 60, 80);
      context.font = '23px sans-serif'; context.fillText('报告文字预览测试', 60, 150);
      context.fillText('所有识别内容均需核对原报告', 60, 210);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByLabel('上传报告图片', { exact: true }).setInputFiles({ name: 'report.png', mimeType: 'image/png', buffer: Buffer.from(picture, 'base64') });
    await expect(page.locator('.image-item img')).toHaveCount(1);
    await page.getByRole('button', { name: '查看报告图片1' }).click();
    await expect(page.getByRole('dialog', { name: '报告图片预览' })).toBeVisible();
    expect(await page.locator('.preview-content > img').evaluate(image => image.complete && image.naturalWidth === 900)).toBe(true);
    await page.screenshot({ path: `test-results/${type}-${test.info().project.name}-image-preview.png`, fullPage: true });
    await page.getByRole('button', { name: '关闭图片预览' }).click();
    await page.getByRole('textbox', { name: '病历与检查记录' }).fill(inputs[type].description);
    await page.getByRole('button', { name: '开始评估' }).click();
    await expect(page.locator('.conclusion')).toBeVisible();
    expect(submitted.images[0].mimeType).toBe('image/jpeg');
    expect(submitted.images[0].data.startsWith('/9j/')).toBe(true);
    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/${type}-${test.info().project.name}-320px.png`, fullPage: true });
  });
}
