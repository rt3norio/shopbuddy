# ShopBuddy

Extensão do Chrome que traduz páginas de compra (Mercado Livre, Amazon, Shopee, AliExpress) em JSON
compacto com ids clicáveis, para o Claude navegar sem ler HTML nem tirar screenshot. O Claude faz o
trabalho sozinho e só pede ajuda ao usuário quando aparece captcha ou login: nessa hora a página
mostra um aviso amarelo.

```
extension/manifest.json   MV3, content script no MAIN world (expõe window.ShopBuddy)
extension/shopbuddy.js    núcleo: extratores por site + genérico, ids, ações
cli/sb.mjs                CLI via CDP (clique real, espera captcha, imprime snapshot após cada ação)
cli/cdp.mjs               cliente CDP mínimo (Node >= 22, sem dependências)
claude-skill/SKILL.md     skill do Claude Code: copie para ~/.claude/skills/shopbuddy/
```

## Usar com Claude Code
1. Instale a extensão (abaixo).
2. Copie `claude-skill/SKILL.md` para `~/.claude/skills/shopbuddy/SKILL.md` e troque `<REPO>` pelo caminho do clone.
3. Ligue o MCP `chrome-devtools` no Chrome (`npx chrome-devtools-mcp@latest --autoConnect`, com o
   toggle de `chrome://inspect/#remote-debugging` ligado). O Claude chama `ShopBuddy.s()` via `evaluate_script`.

## Instalar a extensão (uma vez)
1. `chrome://extensions` → ligar **Modo do desenvolvedor**
2. **Carregar sem compactação** → escolher a pasta `extension/` deste repositório
3. Recarregar as abas das lojas que já estavam abertas.

Sem a extensão, tudo continua funcionando: o MCP injeta via `evaluate_script(sourcePath=...)` e o CLI injeta sozinho.

## Exemplo de snapshot (busca no ML)
```
{"v":"0.1.0",
"site":"ml",
"page":"search",
"url":"lista.mercadolivre.com.br/fone-bluetooth-jbl",
"total":"1.824 resultados",
"count":68,
"items":[
 {"id":"p2","name":"Headset JBL Gamer Quantum 360 Wireless Preto","price":502.11,"old":699,"ship":"Chegará grátis amanhã","full":true,"rating":"4.8","seller":"JBL","ad":true},
 {"id":"p3","name":"Fones de ouvido sem fio Jbl Wave Flex, cor preta","price":310,"ship":"Chegará grátis sábado","rating":"4.8","ad":true}
],
"next":"a82",
"searchBox":"f1"}
```

## API (`window.ShopBuddy`)
| chamada | faz |
|---|---|
| `snap({n,from,all})` / `s()` | página → objeto / texto compacto |
| `click(id)` `type(id,txt,{enter})` `select(id,v)` | agir por id |
| `search(q,[site])` `cart([site])` `addToCart([itemId])` `go(url)` | atalhos |
| `find(txt,{any})` `read(id)` `scroll(dir\|id)` `wait(ms\|txt\|sel)` | utilidades |
| `notify(msg)` | aviso visível para o usuário na página |

Tipos de página: `search`, `product`, `cart`, `checkout`, `login`, `captcha`, `other`.

## CLI
Precisa de um Chrome com `--remote-debugging-port` (endpoints `/json`). O Chrome no modo toggle
do `chrome://inspect` pede aprovação a cada cliente novo, então nesse caso use o MCP.
```
node cli/sb.mjs open ml
node cli/sb.mjs search resistor 10k --n 5
node cli/sb.mjs click p3          # clique real via Input.dispatchMouseEvent
node cli/sb.mjs add               # adicionar ao carrinho na página do produto
node cli/sb.mjs cart
SB_CDP=http://127.0.0.1:9223 node cli/sb.mjs snap   # outra porta
```
O CLI usa uma aba própria (salva em `~/.shopbuddy/state.json`) e traz a aba para frente: aba em
segundo plano não renderiza (o `requestAnimationFrame` fica pausado). Se cair em captcha/login, ele
apita, mostra o aviso e espera até 5 min (`--no-wait` desliga).

## Verificado (2026-10-22)
- **Mercado Livre**: busca (preço, preço riscado, Full, frete/prazo, vendedor, patrocinado), produto,
  adicionar → carrinho (itens, qty, +/−, remover, resumo) → remover; login detectado.
- **Amazon**: busca, produto com variações (com preço por variação), adicionar, carrinho, excluir.
- **AliExpress**: busca, produto (variações, frete), adicionar (gaveta lateral), carrinho.
- **Shopee**: sem login, cai em `/verify/traffic` → `page:"captcha"` + aviso ao usuário. Busca, produto e
  carrinho usam o extrator genérico (cards agrupados por link de produto), ainda não testados logado.
