# -----------------------------------------------------------------------------
# Kai Custom Endpoint — 构建 & 打包 Makefile
#
# 常用命令:
#   make            # 等价于 make build(安装依赖 + 编译)
#   make install    # 安装 npm 依赖(含打包工具 @vscode/vsce)
#   make build      # 编译 TypeScript 到 out/
#   make watch      # 监听模式编译
#   make package    # 打包生成 .vsix(含 build)
#   make vsix       # 仅打包(跳过编译,需先 build)
#   make clean      # 清理 out/ 和 *.vsix
#   make install-global # 可选:全局安装 vsce(也可用 npx 自动下载)
# -----------------------------------------------------------------------------

# 包名(来自 package.json 的 name)
EXT_NAME   := kai-customendpoint
# VSIX 输出目录
DIST_DIR   := dist
# 打包产物:name-version.vsix(version 从 package.json 读取)
VERSION    := $(shell node -p "require('./package.json').version")
VSIX       := $(DIST_DIR)/$(EXT_NAME)-$(VERSION).vsix

# 工具
NPM    := npm
TSC    := node_modules/.bin/tsc
VSCE   := node_modules/.bin/vsce
NODE   := node

.PHONY: all install build watch package vsix clean install-global help

all: build

help:
	@echo "可用目标:"
	@echo "  make install      安装 npm 依赖(含 @vscode/vsce)"
	@echo "  make build        编译 TypeScript 到 out/"
	@echo "  make watch        监听模式编译"
	@echo "  make package      编译 + 打包生成 $(VSIX)"
	@echo "  make vsix         仅打包(需先 make build)"
	@echo "  make clean        清理 out/ 与 dist/"
	@echo "  make install-global 全局安装 @vscode/vsce"

# --- 安装依赖 ---
install:
	$(NPM) install
	@echo "==> 依赖安装完成"

# 确保打包工具可用(未安装时自动作为 devDependency 安装)
node_modules/.bin/vsce:
	$(NPM) install --save-dev @vscode/vsce
	@echo "==> @vscode/vsce 已安装"

# --- 编译 ---
build:
	$(TSC) -p ./
	@echo "==> 编译完成 (out/)"

watch:
	$(TSC) -watch -p ./

# --- 打包 ---
# 依赖 build 与 vsce;产出 .vsix 到 dist/
$(VSIX): node_modules/.bin/vsce | dist
	$(VSCE) package --out "$(VSIX)"
	@echo "==> 打包完成: $(VSIX)"

# 确保输出目录存在(vsce 不会自动创建)
dist:
	mkdir -p dist

package: build $(VSIX)

vsix: $(VSIX)

# --- 清理 ---
clean:
	rm -rf out dist *.vsix
	@echo "==> 已清理 out/ 与 dist/"

# --- 可选:全局安装 vsce ---
install-global:
	$(NPM) install -g @vscode/vsce
	@echo "==> @vscode/vsce 已全局安装"
