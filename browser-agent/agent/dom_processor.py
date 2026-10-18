def get_label(element, soup):
    """
    Extract the semantic label of a form field.

    Priority:
    1. aria-labelledby
    2. aria-label
    3. explicit <label for="">
    4. parent <label>
    5. nearby question/container text
    6. placeholder
    7. name
    """

    # --------------------------------------------------
    # 1. aria-labelledby
    # --------------------------------------------------
    labelled_by = element.get("aria-labelledby")

    if labelled_by:

        texts = []

        for ref_id in labelled_by.split():

            target = soup.find(
                id=ref_id
            )

            if target:

                text = target.get_text(
                    " ",
                    strip=True
                )

                if text:
                    texts.append(text)

        if texts:
            return " ".join(texts)


    # --------------------------------------------------
    # 2. aria-label
    # --------------------------------------------------
    aria_label = element.get(
        "aria-label"
    )

    if aria_label:

        # "Your answer" is Google Forms'
        # generic input label, not the question.
        if aria_label.strip().lower() != "your answer":
            return aria_label.strip()


    # --------------------------------------------------
    # 3. Explicit <label for="">
    # --------------------------------------------------
    element_id = element.get("id")

    if element_id:

        label = soup.find(
            "label",
            attrs={"for": element_id}
        )

        if label:

            text = label.get_text(
                " ",
                strip=True
            )

            if text:
                return text


    # --------------------------------------------------
    # 4. Parent <label>
    # --------------------------------------------------
    parent_label = element.find_parent(
        "label"
    )

    if parent_label:

        text = parent_label.get_text(
            " ",
            strip=True
        )

        if text:
            return text


    # --------------------------------------------------
    # 5. Nearby Google Forms question
    # --------------------------------------------------

    parent = element.parent

    for _ in range(6):

        if parent is None:
            break

        text = parent.get_text(
            " ",
            strip=True
        )

        if text:

            # Avoid returning only generic input text
            if text.lower() not in {
                "your answer",
                "required"
            }:

                # Don't return enormous containers
                if len(text) <= 300:
                    return text

        parent = parent.parent


    # --------------------------------------------------
    # 6. Placeholder
    # --------------------------------------------------
    placeholder = element.get(
        "placeholder"
    )

    if placeholder:
        return placeholder.strip()


    # --------------------------------------------------
    # 7. Name attribute
    # --------------------------------------------------
    name = element.get("name")

    if name:
        return name.strip()

# --------------------------------------------------
# BUTTONS
# --------------------------------------------------

button_elements = soup.find_all(
    lambda tag: (
        tag.name == "button"
        or tag.get("role") == "button"
        or tag.get("type", "").lower()
        in {"submit", "button", "reset"}
    )
)

for index, element in enumerate(button_elements):

    text = (
        get_text(element)
        or element.get(
            "aria-label",
            ""
        )
        or element.get(
            "value",
            ""
        )
    )

    field_id = (
        element.get("id")
        or element.get("data-pf-id")
        or f"button_{index}"
    )

    fields.append({
        "field_id": field_id,
        "element": element.name,
        "type": (
            element.get("type")
            or "button"
        ).lower(),
        "label": text,
    })

    return ""
