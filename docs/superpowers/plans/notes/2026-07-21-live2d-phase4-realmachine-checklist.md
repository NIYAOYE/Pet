# Live2D Phase 4 真机验证清单

代码/自动化部分已完成(`pnpm typecheck && pnpm test && pnpm build` 全绿),以下必须真机人工验证,agent 会话无法自动化(无 GPU/无显示器)。

## 准备

1. 跑一次 `pnpm live2d:setup`,确认成功产出 `vendor/live2d-core/live2dcubismcore.js` 和 `src/renderer/public/live2dcubismcore.js`。
2. 通过应用内"导入 Live2D 模型"UI,把 `D:\LProject\claude_Project\live2dModel\白-免费版\` 和 `D:\LProject\claude_Project\live2dModel\茕兔pack\茕兔\` 分别导入成两个 `pets/<id>/` 包(茕兔pack 导入时应该会触发游离表情/动作找回提示——这条路径 Phase 2 已验证过,这里只是确认走一遍导入 UI 没有回归)。
3. `pnpm preview` 启动应用。

## 验证项

- [ ] 两个 live2d 宠物在寄养选择器/设置下拉框里从"置灰禁用"变成可正常选中(`renderReady` 翻转生效)。
- [ ] 把 `settings.json` 的 `activePetId` 手动改成其中一个 live2d 宠物的 id 后重启应用,能正常启动并渲染(不回退到默认 sprite 宠物)。
- [ ] 从默认 sprite 宠物(luluka)热切换到 live2d 宠物:能看到模型正常渲染(不黑屏、不花屏),接受切换瞬间的一次可见闪烁(这是本阶段确认接受的已知缺口,不是 bug)。
- [ ] 从 live2d 宠物热切换回 sprite 宠物:同样能正常切回,不抛错(验证 Task 10 的类型热切换修复)。
- [ ] 从一个 live2d 宠物热切换到另一个 live2d 宠物。
- [ ] 点击穿透:模型像素上不穿透、透明区域穿透。
- [ ] 拖拽移动窗口时模型跟手,行走状态左右镜像观感正确(`setFacing`)。
- [ ] 双击/单击等既有交互(戳、开对话框)在 live2d 宠物上行为和 sprite 宠物一致。
- [ ] 打开开发者工具(如果需要临时加回 `webPreferences.devTools`,验证完记得改回去)检查 console,确认版本兼容 patch 生效、没有 `drawables.renderOrders` 相关的报错或黑屏。
- [ ] 检查 CSP 没有拦截 `kibo-pet://` 资源或 `live2dcubismcore.js` 脚本加载(console 里不应该出现 CSP violation 报错)。
- [ ] `pnpm dist` 打包一次,确认打包产物里没有意外带上 `node_modules/pixi.js`/`node_modules/untitled-pixi-live2d-engine`(它们应该已经被 Vite 完整打进 `out/renderer` 的 bundle,`devDependencies` 声明不会被 electron-builder 打进最终 `node_modules`)。

## 反馈

把每一项的结果(通过/不通过 + 具体现象)发回来,不通过的项目附上 console 报错和肉眼观察到的现象(黑屏/花屏/卡顿/贴图错位等)。
