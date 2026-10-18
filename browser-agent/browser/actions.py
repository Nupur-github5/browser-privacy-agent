from .controller import BrowserController


class BrowserActions:

    def __init__(self, browser: BrowserController):
        self.browser = browser

    async def fill_field(self, field_id, value):

        page = await self.browser.current_page()

        elements = page.locator(
            "input, textarea, select, button"
        )

        fields = await elements.count()

        for index in range(fields):

            current_id = f"FIELD_{index}"

            if current_id != field_id:
                continue

            element = elements.nth(index)

            tag = await element.evaluate(
                "el => el.tagName.toLowerCase()"
            )

            input_type = await element.get_attribute("type")

            if tag == "input" and input_type in [
                "checkbox",
                "radio"
            ]:

                await element.check()

            elif tag == "select":

                await element.select_option(
                    value=value
                )

            else:

                await element.fill(value)

            return True

        return False

    async def click_field(self, field_id):

        page = await self.browser.current_page()

        elements = page.locator(
            "input, textarea, select, button"
        )

        count = await elements.count()

        for index in range(count):

            if f"FIELD_{index}" == field_id:

                await elements.nth(index).click()

                return True

        return False

    async def submit(self):

        page = await self.browser.current_page()

        selectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:has-text("Submit")',
            'button:has-text("Send")',
            'button:has-text("Apply")',
            'button:has-text("Continue")'
        ]

        for selector in selectors:

            locator = page.locator(selector)

            count = await locator.count()

            if count > 0:

                await locator.first.click()

                return True

        return False
