import asyncio

from agent.agent import (
    create_browser_agent,
    browser
)


async def main():

    print("Connecting to your existing Chrome...")

    await browser.connect()

    print()
    print("CONNECTED")

    page = await browser.current_page()

    if page is not None:

        print(f"URL: {page.url}")

        try:
            print(f"TITLE: {await page.title()}")
        except Exception:
            print("TITLE: unavailable")

    else:

        print("No current page found.")

    print()

    agent = create_browser_agent()

    while True:

        user_request = input(
            "What should the agent do? "
        ).strip()

        if not user_request:
            continue

        if user_request.lower() in {
            "exit",
            "quit"
        }:
            break

        print()
        print("Agent is working...")
        print()

        try:

            result = await agent.ainvoke(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": user_request
                        }
                    ]
                }
            )

            messages = result.get(
                "messages",
                []
            )

            if messages:

                final_message = messages[-1]

                content = getattr(
                    final_message,
                    "content",
                    None
                )

                if content:
                    print()
                    print("Agent:")
                    print(content)

        except Exception as e:

            print()
            print("Agent error:")
            print(e)

        print()


if __name__ == "__main__":
    asyncio.run(main())
