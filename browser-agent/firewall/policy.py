BLOCKED_KEYWORDS = {
    "password",
    "passwd",
    "passcode",

    "aadhaar",
    "aadhar",

    "pan card",
    "pan",

    "credit card",
    "card number",
    "cvv",
    "cvc",

    "bank account",
    "account number",

    "otp",
    "one time password",

    "secret",
    "security answer"
}


SENSITIVE_KEYWORDS = {
    "phone",
    "mobile",
    "email",
    "date of birth",
    "dob",
    "address",
    "location"
}


def classify_field(field):

    text_parts = [
        field.get("name"),
        field.get("id"),
        field.get("placeholder"),
        field.get("aria_label"),
        field.get("label"),
        field.get("text"),
        field.get("parent_text")
    ]

    text = " ".join(
        str(x)
        for x in text_parts
        if x
    ).lower()

    for keyword in BLOCKED_KEYWORDS:

        if keyword in text:
            return "BLOCKED"

    for keyword in SENSITIVE_KEYWORDS:

        if keyword in text:
            return "SENSITIVE"

    return "ALLOWED"
