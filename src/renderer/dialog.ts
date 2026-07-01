import type { ChatMessage } from '@shared/ipc'

const panel = document.getElementById('panel') as HTMLElement

function render(messages: ChatMessage[]): void {
  panel.innerHTML = ''
  const list = document.createElement('div')
  for (const m of messages) {
    const el = document.createElement('div')
    el.textContent = `${m.role === 'user' ? '你' : '露露卡'}: ${m.text}`
    list.appendChild(el)
  }
  panel.appendChild(list)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '说点什么…'
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = input.value.trim()
      if (text) { window.chatApi.send({ text }); input.value = '' }
    }
  })
  panel.appendChild(input)
  input.focus()
}

window.chatApi.onUpdate(render)
render([]) // 初始空
