from .controller import BrowserController


class FormInspector:

    def __init__(self, browser: BrowserController):
        self.browser = browser

    async def inspect(self):

        page = await self.browser.current_page()

        fields = await page.locator(
            "input, textarea, select, button"
        ).evaluate_all(
            """
            elements => elements.map((el, index) => {

                const rect = el.getBoundingClientRect();

                let label = "";

                if (el.labels && el.labels.length > 0) {
                    label = Array.from(el.labels)
                        .map(l => l.innerText)
                        .join(" ");
                }

                const parentText =
                    el.parentElement?.innerText || "";

                return {
                    field_id: "FIELD_" + index,

                    tag: el.tagName.toLowerCase(),

                    type: el.type || null,

                    name: el.name || null,

                    id: el.id || null,

                    placeholder:
                        el.placeholder || null,

                    aria_label:
                        el.getAttribute("aria-label"),

                    label: label,

                    text:
                        el.innerText ||
                        el.value ||
                        null,

                    required:
                        el.required || false,

                    disabled:
                        el.disabled || false,

                    visible:
                        rect.width > 0 &&
                        rect.height > 0,

                    parent_text:
                        parentText.substring(0, 300),

                    options:
                        el.tagName.toLowerCase() === "select"
                        ?
                        Array.from(el.options).map(o => ({
                            text: o.text,
                            value: o.value
                        }))
                        :
                        []
                };
            })
            """
        )

        return fields
