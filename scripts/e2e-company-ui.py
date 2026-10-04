"""Browser checks for the company pages (docs/notes/company-spec.md §9 items 3, 9, 10 + /new).

Runs against a HELD isolated stack (`PAW_E2E_HOLD=1 node scripts/e2e-company.ts` prints `HOLD <url>`).
Asserts COMPUTED STYLE, never class flags (the taskspad `[hidden]` lesson), and saves screenshots.

    /opt/homebrew/opt/python@3.10/bin/python3.10 scripts/e2e-company-ui.py <base-url> <screenshot-dir>
"""
import re
import sys

from playwright.sync_api import sync_playwright

BASE, OUT = sys.argv[1].rstrip("/"), sys.argv[2]
fails = 0


def ok(label, cond, detail=""):
    global fails
    print(("✓ " if cond else "✗ ") + label + (f" — {detail}" if detail else ""))
    if not cond:
        fails += 1


def display(page, sel):
    return page.evaluate("s => { const e = document.querySelector(s); return e ? getComputedStyle(e).display : 'missing' }", sel)


with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ("light", "dark"):
        ctx = b.new_context(viewport={"width": 1400, "height": 900}, color_scheme=scheme)
        page = ctx.new_page()
        bad = []
        errors = []
        page.on("response", lambda r: bad.append(f"{r.status} {r.url}") if r.status >= 400 else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{BASE}/company/test-co")
        page.wait_for_selector(".co-lane", timeout=30000)
        page.wait_for_timeout(1500)
        ok(f"[{scheme}] /company/test-co loads with no 4xx (app.js resolved absolutely)", not bad, "; ".join(bad))
        ok(f"[{scheme}] no page errors", not errors, "; ".join(errors))
        ok(f"[{scheme}] #company is PAINTED (computed display)", display(page, "#company") != "none")
        ok(f"[{scheme}] the chat composer underneath is not painted", display(page, "#comp") == "none")
        ok(f"[{scheme}] the drawer is not painted before an issue is opened", display(page, ".co-drawer") in ("none", "missing"))
        strip = page.inner_text(".co-members")
        ok(f"[{scheme}] header shows both members with channel state", "alpha" in strip and "beta" in strip and ("joined" in strip or "invited" in strip), strip)
        ok(f"[{scheme}] CLIENT_BUILD stamp is visible", page.is_visible(".co-build") and "build company-" in page.inner_text(".co-build"))
        ok(f"[{scheme}] exactly one sidebar row is lit, and it is the company", page.evaluate("[...document.querySelectorAll('.side .row.active')].map(r=>r.textContent.trim())") == ["▣test-co"], str(page.evaluate("[...document.querySelectorAll('.side .row.active')].map(r=>r.textContent.trim())")))
        page.screenshot(path=f"{OUT}/company-work-{scheme}.png")
        if scheme == "light":
            page.click(".co-card[data-id] .co-ctitle")
            page.wait_for_timeout(800)
            ok("clicking a card PAINTS the drawer", display(page, ".co-drawer") == "flex")
            ok("the drawer deep-links ?issue=", "issue=" in page.url, page.url)
            page.wait_for_timeout(1500)
            page.screenshot(path=f"{OUT}/company-drawer-light.png")
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            ok("Esc closes the drawer and STAYS on the company page", display(page, ".co-drawer") in ("none", "missing") and "/company/test-co" in page.url, page.url)
            page.keyboard.press("j")
            page.keyboard.press("Enter")
            page.wait_for_timeout(500)
            ok("j + Enter opens the selected card", display(page, ".co-drawer") == "flex")
            page.keyboard.press("Escape")
            page.keyboard.press("2")
            page.wait_for_timeout(400)
            ok("2 → Org tab renders the tree", page.is_visible(".co-otree") and "alpha" in page.inner_text(".co-otree"))
            page.screenshot(path=f"{OUT}/company-org-light.png")
            page.keyboard.press("3")
            page.wait_for_timeout(400)
            ok("3 → Activity shows the kickoff", "test-co" in page.inner_text(".co-feed"))
            page.screenshot(path=f"{OUT}/company-activity-light.png")
            page.keyboard.press("1")
            page.click('.co-seg [data-group="status"]')
            page.wait_for_timeout(400)
            heads = page.eval_on_selector_all(".co-lane .co-lhead b", "els => els.map(e => e.textContent)")
            ok("group by status = the fixed board columns", heads[:4] == ["To do", "In progress", "Blocked", "Done"], str(heads))
            page.screenshot(path=f"{OUT}/company-status-light.png")
            page.click('.co-seg [data-group="agent"]')
            page.goto(f"{BASE}/company/nope")
            page.wait_for_timeout(1500)
            ok("/company/nope → 'no company nope' + a link to /new?name=nope", "no company nope" in page.inner_text("#company") and page.locator('a[href="/new?name=nope"]').count() == 1)
            page.goto(f"{BASE}/new")
            page.wait_for_selector(".co-new")
            page.fill('[data-nf="name"]', "UI Co")
            ok("/new derives the slug from the name", page.input_value('[data-nf="slug"]') == "ui-co")
            page.check('[data-pick="alpha"]')
            page.wait_for_timeout(200)
            ok("the first picked agent becomes the lead", page.is_checked('[data-lead="alpha"]'))
            page.screenshot(path=f"{OUT}/company-new-light.png")
            page.click('[data-act="create"]')
            page.wait_for_url(re.compile(r"/company/ui-co"), timeout=60000)
            page.wait_for_selector(".co-lane", timeout=30000)
            ok("Create → lands on /company/ui-co", "/company/ui-co" in page.url)
            page.go_back()
            page.wait_for_timeout(800)
            ok("Back returns to /new (pushState history)", page.url.endswith("/new"), page.url)
        ctx.close()

    # phone width: no horizontal page scroll, lanes stacked
    ctx = b.new_context(viewport={"width": 390, "height": 844}, color_scheme="light", is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.goto(f"{BASE}/company/test-co")
    page.wait_for_selector(".co-lane", timeout=30000)
    page.wait_for_timeout(1000)
    sw = page.evaluate("Math.max(document.documentElement.scrollWidth, document.querySelector('.co-body').scrollWidth)")
    ok("phone: zero horizontal scroll (scrollWidth == 390)", sw <= 390, str(sw))
    stacked = page.evaluate("(() => { const l=[...document.querySelectorAll('.co-lane')]; return l.length>1 && l[1].getBoundingClientRect().top > l[0].getBoundingClientRect().top })()")
    ok("phone: lanes stack vertically", stacked)
    ok("phone: the ☰ menu is painted", display(page, ".co-menu") != "none")
    page.screenshot(path=f"{OUT}/company-phone.png", full_page=False)
    ctx.close()

    # storage that THROWS: the page must still render and work
    ctx = b.new_context(viewport={"width": 1200, "height": 800})
    ctx.add_init_script("for (const k of ['getItem','setItem','removeItem']) Storage.prototype[k] = () => { throw new Error('blocked') }")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(f"{BASE}/company/test-co")
    page.wait_for_selector(".co-lane", timeout=30000)
    page.click('.co-seg [data-group="goal"]')
    page.wait_for_timeout(300)
    ok("localStorage throwing → page renders and the grouping still switches", page.locator(".co-lane").count() > 0 and not errs, "; ".join(errs))
    ctx.close()
    b.close()

print(f"\n{fails} browser check(s) failed" if fails else "\nall company browser checks passed")
sys.exit(1 if fails else 0)
