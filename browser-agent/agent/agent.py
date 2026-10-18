import os
from dotenv import load_dotenv

load_dotenv("/home/jays/browser-agent/.env")

from langchain.agents import create_agent
from langchain_groq import ChatGroq

from langchain.tools import tool

from browser.controller import BrowserController
from browser.inspector import FormInspector
from browser.actions import BrowserActions
from firewall.sanitizer import sanitize_fields


browser = BrowserController()

inspector = FormInspector(browser)

actions = BrowserActions(browser)

@tool
async def inspect_current_page():
    """
    Inspect the current page in the user's existing Chrome.

    Returns the available form fields with privacy classifications.
    """

    fields = await inspector.inspect()

    sanitized = sanitize_fields(fields)

    return str(sanitized)


@tool
async def fill_field(
    field_id: str,
    value: str
):
    """
    Fill a form field using its FIELD_ID.

    Only fields classified as ALLOWED may be filled.
    """

    fields = await inspector.inspect()

    target = None

    for field in fields:

        if field.get("field_id") == field_id:

            target = field
            break

    if target is None:

        return f"{field_id} does not exist."

    sanitized = sanitize_fields([target])

    classification = sanitized[0]["privacy"]

    if classification != "ALLOWED":

        return (
            f"Privacy firewall blocked {field_id}. "
            f"Classification: {classification}"
        )

    success = await actions.fill_field(
        field_id,
        value
    )

    if success:

        return f"Successfully filled {field_id}."

    return f"Could not fill {field_id}."


@tool
async def click_submit():
    """
    Click the submit button on the current webpage.
    """

    success = await actions.submit()

    if success:

        return "Submit button clicked successfully."

    return "Submit button could not be found."


def create_browser_agent():

    model = ChatGroq(
        model="openai/gpt-oss-120b",
        temperature=0
    )

    agent = create_agent(

        model=model,

        tools=[
            inspect_current_page,
            fill_field,
            click_submit
        ],

        system_prompt="""
You are a browser automation agent.

You operate ONLY on the user's existing Chrome browser.

Never launch another browser.

GENERAL WORKFLOW:

1. Inspect the current page.
2. Understand the user's task.
3. Identify the relevant form field.
4. Use the FIELD_ID returned by inspection.
5. Never guess FIELD_ID values.
6. Never expose or use blocked fields.
7. Only fill fields classified ALLOWED.
8. Sensitive or blocked fields must not be filled.
9. Only click submit when the user explicitly asks for submission.
10. After completing the requested task, stop.

IMPORTANT:

The page may be ANY website.

Do not assume:
- Google Forms
- a specific HTML structure
- a specific field name
- a specific CSS selector

Use the inspected semantic information.

Example:

User:
"Fill the form with name Jay."

Workflow:

inspect_current_page()

Find the field representing the user's name.

If it is ALLOWED:

fill_field(
    field_id="FIELD_X",
    value="Jay"
)

Do NOT fill unrelated fields.

Example:

User:
"Fill the form with name Jay and submit it."

Workflow:

1. inspect_current_page()
2. Find name field.
3. fill_field(...)
4. click_submit()

Never invent personal information.
"""
    )

    return agent
