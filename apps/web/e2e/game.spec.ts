import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * Three separate browser contexts (separate cookies, like separate browsers)
 * play one turn: create, invite, start, choose, draw, guess, see the result.
 * Set SCREENSHOT_DIR to save screenshots of each screen.
 */

const shots = process.env.SCREENSHOT_DIR
/** Console errors that mean the page was broken, e.g. by the Content Security Policy. */
const consoleProblems: string[] = []

test.afterEach(() => {
  expect(consoleProblems).toEqual([])
  consoleProblems.length = 0
})

async function snap(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` })
}

async function player(browser: Browser, viewport = { width: 1366, height: 800 }) {
  const context: BrowserContext = await browser.newContext({ viewport })
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) consoleProblems.push(msg.text())
  })
  page.on('pageerror', (err) => consoleProblems.push(err.message))
  return { context, page }
}

async function enterProfile(page: Page, name: string) {
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Next eyes' }).click()
}

async function drawSquiggle(page: Page) {
  const canvas = page.getByRole('img', { name: 'Your drawing canvas' })
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3)
  await page.mouse.down()
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + box.width * (0.2 + i * 0.02), box.y + box.height * (0.3 + Math.sin(i / 3) * 0.15), {
      steps: 2,
    })
  }
  await page.mouse.up()
}

test('three players play a turn', async ({ browser }) => {
  const host = await player(browser)
  const guest = await player(browser)
  const mobile = await player(browser, { width: 390, height: 844 })

  await host.page.goto('/')
  await snap(host.page, '01-home')
  await enterProfile(host.page, 'Ana')
  await host.page.getByRole('button', { name: 'Create room!' }).click()
  await expect(host.page.getByRole('heading', { name: 'Room settings' })).toBeVisible()
  const roomUrl = host.page.url()

  for (const [p, name] of [
    [guest, 'Bo'],
    [mobile, 'Cy'],
  ] as const) {
    await p.page.goto(roomUrl)
    await enterProfile(p.page, name)
    await p.page.getByRole('button', { name: 'Join room!' }).click()
    await expect(p.page.getByRole('heading', { name: 'Waiting for the host…' })).toBeVisible()
  }
  await expect(host.page.getByRole('button', { name: 'Start!' })).toBeEnabled()
  await snap(host.page, '02-lobby-host')
  await snap(mobile.page, '03-lobby-mobile')

  await host.page.getByRole('button', { name: 'Start!' }).click()
  await expect(host.page.getByRole('heading', { name: 'Choose a word' })).toBeVisible()
  await expect(guest.page.getByText('Ana is choosing a word!')).toBeVisible()
  await snap(host.page, '04-choose-word')
  await snap(guest.page, '05-choosing-guest')

  const wordButton = host.page.locator('.animate-pop button').first()
  const word = (await wordButton.textContent())!.trim()
  await wordButton.click()
  await expect(host.page.getByRole('toolbar', { name: 'Drawing tools' })).toBeVisible()

  await drawSquiggle(host.page)
  await host.page.getByRole('radio', { name: 'Red', exact: true }).click()
  await host.page.getByRole('radio', { name: 'Brush size 28' }).click()
  await drawSquiggle(host.page)
  await expect(guest.page.getByText('Guess this')).toBeVisible()
  await snap(host.page, '06-drawing-host')

  await guest.page.getByLabel('Guess or chat').fill('banana split')
  await guest.page.getByLabel('Guess or chat').press('Enter')
  await expect(mobile.page.getByText('banana split')).toBeVisible()
  await snap(guest.page, '07-guessing-guest')
  await snap(mobile.page, '08-guessing-mobile')

  await guest.page.getByLabel('Guess or chat').fill(word)
  await guest.page.getByLabel('Guess or chat').press('Enter')
  await expect(host.page.getByText('Bo guessed the word!')).toBeVisible()
  await expect(guest.page.getByLabel('Guess or chat')).toBeDisabled()

  await mobile.page.getByLabel('Guess or chat').fill(word)
  await mobile.page.getByLabel('Guess or chat').press('Enter')
  await expect(host.page.getByText(`The word was '${word}'`).first()).toBeVisible()
  await snap(host.page, '09-turn-result')
  await snap(mobile.page, '10-turn-result-mobile')

  for (const p of [host, guest, mobile]) await p.context.close()
})

test('a one-round game ends with a podium and replays', async ({ browser }) => {
  const host = await player(browser)
  const guest = await player(browser)
  const mobile = await player(browser, { width: 390, height: 844 })
  const everyone = [host, guest, mobile]

  await host.page.goto('/')
  await enterProfile(host.page, 'Ana')
  await host.page.getByRole('button', { name: 'Create room!' }).click()
  await host.page.getByLabel('Rounds').selectOption('1')
  const roomUrl = host.page.url()
  for (const [p, name] of [
    [guest, 'Bo'],
    [mobile, 'Cy'],
  ] as const) {
    await p.page.goto(roomUrl)
    await enterProfile(p.page, name)
    await p.page.getByRole('button', { name: 'Join room!' }).click()
  }
  await expect(guest.page.getByLabel('Rounds')).toHaveValue('1')
  await host.page.getByRole('button', { name: 'Start!' }).click()

  // Each player draws once, in join order; the other two guess right.
  for (const drawer of everyone) {
    const choice = drawer.page.locator('.animate-pop button').first()
    await expect(choice).toBeVisible({ timeout: 15_000 })
    const word = (await choice.textContent())!.trim()
    await choice.click()
    await expect(drawer.page.getByRole('toolbar', { name: 'Drawing tools' })).toBeVisible()
    await drawSquiggle(drawer.page)
    await drawer.page.getByRole('button', { name: 'Fill (F)' }).click()
    const canvas = drawer.page.getByRole('img', { name: 'Your drawing canvas' })
    await canvas.click({ position: { x: 20, y: 20 } })
    if (drawer === mobile) await snap(mobile.page, '11-drawing-mobile')
    for (const guesser of everyone.filter((p) => p !== drawer)) {
      await guesser.page.getByLabel('Guess or chat').fill(word)
      await guesser.page.getByLabel('Guess or chat').press('Enter')
    }
    await expect(drawer.page.getByText(`The word was '${word}'`).first()).toBeVisible()
  }

  await expect(host.page.getByRole('heading', { name: 'Game over!' })).toBeVisible({ timeout: 15_000 })
  await snap(host.page, '12-game-over')
  await snap(mobile.page, '13-game-over-mobile')

  await guest.page.getByRole('button', { name: 'Watch the drawings' }).click()
  const dialog = guest.page.getByRole('dialog', { name: 'Drawing replays' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: /Round 1/ })).toHaveCount(3)
  await guest.page.waitForTimeout(1500)
  await snap(guest.page, '14-replay')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()

  await host.page.getByRole('button', { name: 'Play again' }).click()
  await expect(host.page.getByRole('heading', { name: 'Room settings' })).toBeVisible()

  for (const p of everyone) await p.context.close()
})
