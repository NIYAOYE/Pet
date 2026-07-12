import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type { BrowserDriverFactory, DriverBrowser, DriverPage } from './browserControl'
import type { LaunchPlan } from './browserLifecycle'

function wrapPage(page: Page): DriverPage {
  return {
    goto: (url) => page.goto(url).then(() => undefined),
    clickByText: async (text) => { await page.getByText(text, { exact: false }).first().click({ timeout: 10000 }) },
    clickBySelector: async (selector) => { await page.locator(selector).first().click({ timeout: 10000 }) },
    fillByLabel: async (text, value) => {
      const byLabel = page.getByLabel(text, { exact: false })
      if (await byLabel.count() > 0) { await byLabel.first().fill(value); return }
      await page.getByPlaceholder(text, { exact: false }).first().fill(value)
    },
    innerText: () => page.locator('body').innerText(),
    screenshot: () => page.screenshot({ type: 'jpeg', quality: 70 }),
    scroll: (deltaY) => page.mouse.wheel(0, deltaY),
    waitForText: async (text, timeoutMs) => { await page.getByText(text, { exact: false }).first().waitFor({ timeout: timeoutMs }) },
    title: () => page.title(),
    url: () => page.url(),
    close: () => page.close()
  }
}

/**
 * pages 必须实时取自 context.pages(),不能自己维护数组快照:网站用 target=_blank
 * 自开的新标签页由 context 直接创建,不经过这里的 newPage()——快照数组永远看不见它,
 * listTabs 缺页、activePage 够不着,模型的感知就永远停在旧标签页(真机复现:B 站点
 * 视频卡片后模型反复"确认还在首页")。context.pages() 同时天然剔除已关闭的页面。
 * 导出供单测(以假 context 验证实时性,不启动真浏览器)。
 */
export function wrapBrowser(browser: Browser, context: BrowserContext): DriverBrowser {
  return {
    pages: () => context.pages().map(wrapPage),
    newPage: async (url) => {
      const page = await context.newPage()
      if (url) await page.goto(url)
      return wrapPage(page)
    },
    close: () => browser.close()
  }
}

export function createPlaywrightDriverFactory(): BrowserDriverFactory {
  return {
    async launch(plan: LaunchPlan): Promise<DriverBrowser> {
      if (plan.kind === 'cdp') {
        const browser = await chromium.connectOverCDP(plan.endpointURL)
        const context = browser.contexts()[0] ?? await browser.newContext()
        if (context.pages().length === 0) await context.newPage()
        return wrapBrowser(browser, context)
      }
      // executablePath(若设置)会让 Playwright 完全绕开 channel 的自动探测——该探测在
      // Windows 上优先检查 %LOCALAPPDATA%,一个损坏的 per-user Chrome 安装会因为"文件存在"
      // 就被选中(不检查能否真的启动),即便系统级安装是好的也会被绕过,见 browserLifecycle.ts。
      const browser = plan.executablePath
        ? await chromium.launch({ executablePath: plan.executablePath, headless: plan.headless })
        : await chromium.launch({ channel: plan.channel, headless: plan.headless })
      const context = await browser.newContext()
      await context.newPage()
      return wrapBrowser(browser, context)
    }
  }
}
