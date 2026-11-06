// Drives the record test page (va-rsk5.5.1/5.5.2): moves, clicks the labelled button, clicks the link, scrolls to the
// password field, types in it, scrolls back.
export default async function tour(page) {
  const wait = (ms) => page.waitForTimeout(ms)
  await wait(600)
  const add = await page.locator('#add').boundingBox()
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(200 + ((add.x + add.width / 2 - 200) * i) / 15, 400 + ((add.y + add.height / 2 - 400) * i) / 15)
    await wait(30)
  }
  await page.mouse.click(add.x + add.width / 2, add.y + add.height / 2)
  await wait(800)
  await page.getByRole('link').click()
  await wait(500)
  await page.mouse.move(400, 400)
  await page.mouse.wheel(0, 700)
  await wait(700)
  await page.locator('#pw').click()
  await page.keyboard.type('hunter22', { delay: 60 })
  await wait(500)
  await page.mouse.wheel(0, -700)
  await wait(800)
}
