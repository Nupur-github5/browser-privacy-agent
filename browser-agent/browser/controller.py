from playwright.async_api import async_playwright


class BrowserController:

    def __init__(self, cdp_url="http://127.0.0.1:9222"):
        self.cdp_url = cdp_url
        self.playwright = None
        self.browser = None
        self.context = None

    async def connect(self):

        self.playwright = await async_playwright().start()

        self.browser = await self.playwright.chromium.connect_over_cdp(
            self.cdp_url,
            is_local=True,
            no_defaults=True
        )

        if not self.browser.contexts:
            raise RuntimeError("No Chrome context found.")

        self.context = self.browser.contexts[0]

        if not self.context.pages:
            raise RuntimeError("No Chrome tabs found.")

        print("Connected to existing Chrome.")

    async def current_page(self):

        if not self.context:
            await self.connect()

        if not self.context.pages:
            raise RuntimeError("No Chrome tabs available.")

        return self.context.pages[-1]

    async def close(self):

        if self.playwright:
            await self.playwright.stop()
