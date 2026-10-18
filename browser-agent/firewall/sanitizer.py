from .policy import classify_field


def sanitize_fields(fields):

    sanitized = []

    for field in fields:

        classification = classify_field(field)

        sanitized.append({

            "field_id":
                field.get("field_id"),

            "tag":
                field.get("tag"),

            "type":
                field.get("type"),

            "label":
                field.get("label"),

            "name":
                field.get("name"),

            "id":
                field.get("id"),

            "placeholder":
                field.get("placeholder"),

            "aria_label":
                field.get("aria_label"),

            "required":
                field.get("required"),

            "visible":
                field.get("visible"),

            "options":
                field.get("options"),

            "privacy":
                classification
        })

    return sanitized
