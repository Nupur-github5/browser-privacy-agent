import os
import json
from pathlib import Path
from agent.dom_processor import get_compact_form_structure
from dotenv import load_dotenv

load_dotenv("/home/jays/browser-agent/.env")

from langchain.agents import create_agent
from langchain_groq import ChatGroq
from langchain.tools import tool

from browser.controller import BrowserController
from browser.inspector import FormInspector
from browser.actions import BrowserActions
from firewall.sanitizer import sanitize_fields


# ============================================================
# FIXED PRIVACY-FIREWALL PATHS
# ============================================================

BASE_DIR = Path(
    "/home/jays/Downloads/My Folder/Projects/SIH/privacy-firewall"
)

DOM_FILE = BASE_DIR / "data" / "dom" / "latest.txt"

VAULT_FILE = BASE_DIR / "data" / "vault" / "vault.json"


# ============================================================
# BROWSER
# ============================================================

browser = BrowserController()

inspector = FormInspector(browser)

actions = BrowserActions(browser)


# ============================================================
# LOCAL DOM LOADER
# ============================================================

def load_latest_dom():
    """
    Load ONLY latest.txt.

    No other .txt file is read.
    """

    if not DOM_FILE.exists():
        raise FileNotFoundError(
            f"DOM file not found:\n{DOM_FILE}"
        )

    return DOM_FILE.read_text(
        encoding="utf-8",
        errors="ignore"
    )


# ============================================================
# LOCAL VAULT LOADER
# ============================================================

def load_vault():
    """
    Load vault locally.

    IMPORTANT:
    This function is NEVER exposed as an LLM tool.
    """

    if not VAULT_FILE.exists():
        raise FileNotFoundError(
            f"Vault file not found:\n{VAULT_FILE}"
        )

    with open(VAULT_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise ValueError(
            "vault.json must contain a JSON object."
        )

    return data


# ============================================================
# FIELD → VAULT RESOLUTION
# ============================================================

def normalize_field_name(name):
    """
    Convert semantic field names into normalized values.
    """

    name = name.lower().strip()

    aliases = {
        "name": "name",
        "first name": "name",
        "firstname": "name",
        "given name": "name",

        "surname": "surname",
        "last name": "surname",
        "lastname": "surname",
        "family name": "surname",
    }

    return aliases.get(name, name)


def resolve_vault_value(field_type):
    """
    Resolve semantic field type locally.

    LLM never receives the returned value.
    """

    vault = load_vault()

    field_type = normalize_field_name(field_type)

    mapping = {
        "name": [
            "[NAME_1]"
        ],

        "surname": [
            "[SURNAME_1]"
        ],

        "email": [
            "[EMAIL_1]"
        ],

        "phone": [
            "[PHONE_1]"
        ],

        "address": [
            "[ADDRESS_1]"
        ],

        "city": [
            "[CITY_1]"
        ],

        "state": [
            "[STATE_1]"
        ],

        "country": [
            "[COUNTRY_1]"
        ],

        "postal code": [
            "[POSTAL_CODE_1]",
            "[PINCODE_1]"
        ],

        "pincode": [
            "[PINCODE_1]",
            "[POSTAL_CODE_1]"
        ],

        "username": [
            "[USERNAME_1]"
        ],
    }

    possible_keys = mapping.get(field_type, [])

    for key in possible_keys:

        if key in vault:

            value = vault[key]

            if value is None:
                return None

            value = str(value).strip()

            if value:
                return value

    return None


# ============================================================
# DOM INSPECTION
# ============================================================

@tool
async def inspect_current_page():
    """
    Return compact semantic form structure.

    Only processed DOM is sent to the LLM.
    Vault data is never included.
    """

    structure = get_compact_form_structure()

    return structure
    # Read the EXISTING latest.txt.
    #
    # We deliberately do not create or modify any DOM file.
    dom = load_latest_dom()

    return dom


# ============================================================
# FIND FIELD
# ============================================================

@tool
async def find_field(field_type: str):
    """
    Find a semantic form field.

    field_type examples:
    name
    surname
    email
    phone
    address

    Returns FIELD_ID only.
    """

    fields = await inspector.inspect()

    sanitized = sanitize_fields(fields)

    wanted = normalize_field_name(field_type)

    for field in sanitized:

        semantic = field.get("semantic_type", "")

        label = field.get("label", "")

        name = field.get("name", "")

        placeholder = field.get(
            "placeholder",
            ""
        )

        candidates = [
            semantic,
            label,
            name,
            placeholder
        ]

        for candidate in candidates:

            if not candidate:
                continue

            normalized = normalize_field_name(
                str(candidate)
            )

            if normalized == wanted:

                privacy = field.get(
                    "privacy",
                    "UNKNOWN"
                )

                if privacy != "ALLOWED":

                    return {
                        "status": "BLOCKED",
                        "field_id": field.get("field_id"),
                        "privacy": privacy
                    }

                return {
                    "status": "FOUND",
                    "field_id": field.get("field_id"),
                    "semantic_type": wanted
                }

    return {
        "status": "NOT_FOUND",
        "semantic_type": wanted
    }


# ============================================================
# FILL FROM VAULT
# ============================================================

@tool
async def fill_from_vault(
    field_id: str,
    field_type: str
):
    """
    Fill a form field using locally stored vault data.

    IMPORTANT PRIVACY PROPERTY:

    The LLM supplies:
        field_id
        field_type

    The LLM does NOT supply:
        actual personal value

    Python loads the value from vault.json locally.
    """

    fields = await inspector.inspect()

    target = None

    for field in fields:

        if field.get("field_id") == field_id:

            target = field
            break

    if target is None:

        return (
            f"Field {field_id} does not exist."
        )

    sanitized = sanitize_fields(
        [target]
    )

    if not sanitized:

        return (
            f"Could not classify {field_id}."
        )

    field_info = sanitized[0]

    privacy = field_info.get(
        "privacy",
        "UNKNOWN"
    )

    if privacy != "ALLOWED":

        return (
            f"Privacy firewall blocked "
            f"{field_id}. "
            f"Classification: {privacy}"
        )

    # --------------------------------------------------------
    # LOCAL VAULT LOOKUP
    # --------------------------------------------------------

    value = resolve_vault_value(
        field_type
    )

    if value is None:

        return (
            f"No value available in vault "
            f"for {field_type}. Skipping field."
        )

    # --------------------------------------------------------
    # ACTUAL VALUE ENTERS BROWSER ONLY HERE
    # --------------------------------------------------------

    success = await actions.fill_field(
        field_id,
        value
    )

    if success:

        return (
            f"Successfully filled "
            f"{field_type} field."
        )

    return (
        f"Could not fill {field_id}."
    )


# ============================================================
# SUBMIT
# ============================================================

@tool
async def click_submit():
    """
    Click the submit button.
    Only call this when the user explicitly requests submission.
    """

    success = await actions.submit()

    if success:

        return (
            "Submit button clicked successfully."
        )

    return (
        "Submit button could not be found."
    )


# ============================================================
# AGENT
# ============================================================

def create_browser_agent():

    api_key = os.getenv(
        "GROQ_API_KEY"
    )

    if not api_key:

        raise RuntimeError(
            "GROQ_API_KEY was not loaded."
        )

    model = ChatGroq(
        model="openai/gpt-oss-120b",
        temperature=0,
        api_key=api_key
    )

    agent = create_agent(

        model=model,

        tools=[
            inspect_current_page,
            find_field,
            fill_from_vault,
            click_submit
        ],

        system_prompt="""

You are a privacy-first browser automation agent.

============================================================
BROWSER
============================================================

You operate ONLY on the user's existing Chrome browser.

Never launch another browser.

Never create another browser profile.

Never open a separate Playwright browser.

============================================================
PRIVACY ARCHITECTURE
============================================================

The DOM structure comes from:

data/dom/latest.txt

ONLY latest.txt is used.

Other files in data/dom/ must be ignored.

The private vault exists separately.

The vault contains actual personal values.

IMPORTANT:

NEVER request the vault contents.

NEVER output vault contents.

NEVER ask the user to provide private values if the vault may contain them.

NEVER send actual vault values to the LLM.

The actual personal value is resolved locally by Python.

============================================================
TASK
============================================================

When the user asks to fill a form:

1. Inspect the current page.

2. Understand the user's requested task.

3. Identify the semantic field required.

Examples:

"name"
"surname"
"email"
"phone"
"address"

4. Find the corresponding FIELD_ID.

5. Use fill_from_vault().

The fill_from_vault() tool receives:

field_id
field_type

It obtains the actual value locally.

You must NEVER provide the actual personal value yourself.

============================================================
IMPORTANT
============================================================

Do NOT assume:

- Google Forms
- HTML structure
- CSS selectors
- field IDs
- field names
- website

Use the inspected information.

Never guess FIELD_ID.

============================================================
MISSING DATA
============================================================

If the vault does not contain a value:

SKIP that field.

Do NOT invent information.

Do NOT ask the LLM to generate personal information.

Do NOT fabricate values.

Fill whatever information is actually available.

============================================================
PRIVACY
============================================================

Only fields classified ALLOWED may be filled.

If a field is BLOCKED or SENSITIVE:

DO NOT fill it.

============================================================
SUBMISSION
============================================================

Only call click_submit() when the user explicitly asks to submit.

If the user only says:

"Fill the form"

do NOT submit.

If the user says:

"Fill the form and submit it"

then submit after filling available allowed fields.

============================================================
EXAMPLE
============================================================

User:

"Fill this form with my name."

Process:

inspect_current_page()

find_field("name")

fill_from_vault(
    field_id="...",
    field_type="name"
)

Do not output the actual name.

============================================================
EXAMPLE
============================================================

User:

"Fill the form with my name and surname and submit it."

Process:

inspect_current_page()

find_field("name")

fill_from_vault(..., "name")

find_field("surname")

fill_from_vault(..., "surname")

click_submit()

============================================================
FINAL RULE
============================================================

LLM decides WHAT field is required.

LOCAL PYTHON decides WHAT private value belongs to that field.

PLAYWRIGHT enters the private value into the existing browser.

The LLM must never see the private value.
"""
    )

    return agent
