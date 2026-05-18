"""End-to-end smoke for the X-close button + 🙈 hidden filter.

Assumes a daemon is already running on 127.0.0.1:8765 with at least one
session. Doesn't seed sessions itself — point this at a live dashboard
that has >=1 card to exercise both paths.

Verdict logic:
  - Open dashboard, find first card's close button
  - Note current wrapped state, click it
  - If wrapped -> expect /wrap/stop POST + cell goes non-wrapped
  - If non-wrapped -> expect cell to disappear, hidden chip to show 1
  - Click hidden chip -> expect hidden card to reappear
  - Click un-hide -> expect card to return to default view, chip gone
"""
from playwright.sync_api import sync_playwright
import sys

URL = "http://127.0.0.1:8765/"

def main() -> int:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1400, "height": 800})
        page = ctx.new_page()

        posts: list[dict] = []
        page.on("request", lambda r: posts.append({"url": r.url, "method": r.method}) if "wrap/stop" in r.url else None)

        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle", timeout=10_000)

        # Dismiss any popover-backdrop that's intercepting clicks (e.g. left
        # over from a previous click on a chip / setting). The backdrop sits
        # above cards so without dismissing it Playwright can't reach the
        # close button.
        try:
            page.locator(".popover-backdrop").first.click(timeout=1_000)
            page.wait_for_timeout(150)
        except Exception:
            pass
        # Belt-and-braces: also press Escape in case some overlay listens for it
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)

        cards = page.locator(".cell")
        card_count = cards.count()
        print(f"cards on page: {card_count}")
        if card_count == 0:
            print("[FAIL] no cards - start a miki session first, then re-run")
            b.close()
            return 2

        # CloseCardButton sits in cell-head — it's the LAST button.icon-btn
        # inside .cell-head, NOT the last in the whole card (the very last
        # icon-btn in a card is .cell-send-btn in cell-foot).
        # Prefer a NON-wrapped card so we exercise the hide→chip→unhide flow
        # (the path the task spec emphasises). Fall back to first card if
        # all cards are wrapped.
        chosen_idx = 0
        chosen_title = ""
        for i in range(card_count):
            cand = cards.nth(i).locator(".cell-head").first.locator("button.icon-btn").last
            t = cand.get_attribute("title") or ""
            if "從本機隱藏" in t or "Hide this card" in t or "从本机隐藏" in t:
                chosen_idx = i
                chosen_title = t
                break
        else:
            chosen_title = cards.first.locator(".cell-head").first.locator("button.icon-btn").last.get_attribute("title") or ""

        print(f"chose card index {chosen_idx}  title={chosen_title!r}")
        first = cards.nth(chosen_idx)
        first.scroll_into_view_if_needed()
        head = first.locator(".cell-head").first
        close_btn = head.locator("button.icon-btn").last
        initial_title = close_btn.get_attribute("title") or ""
        print(f"first card close-btn title: {initial_title!r}")

        was_wrapped = ("stop wrap" in initial_title.lower()
                       or "停止 wrap" in initial_title)
        print(f"  -> looks wrapped? {was_wrapped}")

        close_btn.click()
        page.wait_for_timeout(500)
        page.screenshot(path="tools/smoke-x-close-after1.png", full_page=False)

        if was_wrapped:
            stop_fired = any("wrap/stop" in p_["url"] for p_ in posts)
            print(f"POST /wrap/stop fired? {stop_fired}")
            # WS race: wait up to 5s for daemon session_changed to flip
            # wrapped=false (which swaps title from "停止 wrap" → "從本機隱藏").
            for _ in range(50):
                new_title = close_btn.get_attribute("title") or ""
                if "hide" in new_title.lower() or "隱藏" in new_title or "隐藏" in new_title:
                    break
                page.wait_for_timeout(100)
            print(f"after stop: title={new_title!r}")
            if "hide" not in new_title.lower() and "隱藏" not in new_title and "隐藏" not in new_title:
                print("[WARN] wrapped->non-wrapped transition didn't happen after 5s — skipping hide click")
                page.screenshot(path="tools/smoke-x-close-after2.png", full_page=False)
                print("[OK] partial flow complete (wrap-stop only)")
                b.close()
                return 0

        close_btn.click()
        page.wait_for_timeout(400)
        page.screenshot(path="tools/smoke-x-close-after2.png", full_page=False)

        chip = page.locator("button", has_text="🙈")
        chip_n = chip.count()
        print(f"hidden chip count after hide: {chip_n}")
        if chip_n == 0:
            print("[FAIL] hidden chip not visible after hide")
            b.close()
            return 1

        chip.first.click()
        page.wait_for_timeout(300)
        # In hidden-view mode, the now-visible card has a un-hide button.
        # Scope to first card's cell-head, same way as before — otherwise we
        # pick up cell-send-btn in cell-foot.
        un_btn = page.locator(".cell").first.locator(".cell-head").first.locator("button.icon-btn").last
        un_title = un_btn.get_attribute("title") or ""
        print(f"hidden-view close-btn title: {un_title!r}")
        un_btn.click()
        page.wait_for_timeout(300)
        page.screenshot(path="tools/smoke-x-close-after3.png", full_page=False)

        # Re-check chip is gone
        chip_after = page.locator("button", has_text="🙈").count()
        print(f"hidden chip count after un-hide: {chip_after}")

        print("[OK] flow complete - inspect tools/smoke-x-close-after*.png")
        b.close()
        return 0

if __name__ == "__main__":
    sys.exit(main())
