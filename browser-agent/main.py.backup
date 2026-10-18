import asyncio

from agent.agent import create_browser_agent, browser


async def main():

    print("Connecting to your existing Chrome...")

    await browser.connect()

    page = await browser.current_page()

    print()
    print("CONNECTED")
    print("URL:", page.url)
    print("TITLE:", await page.title())
    print()

    agent = create_browser_agent()

    task = input(
        "What should the agent do? "
    )

    print()
    print("Agent is working...")
    print()

    result = await agent.ainvoke(
        {
            "messages": [
                {
                    "role": "user",
                    "content": task
                }
            ]
        }
    )

    print()
    print("FINAL RESULT:")
    print(
        result["messages"][-1].content
    )

    await browser.close()


if __name__ == "__main__":

    asyncio.run(main())
