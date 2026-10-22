---
name: shopbuddy
description: Navegar e comprar em Mercado Livre, Amazon, Shopee e AliExpress no Chrome do usuário lendo a página como JSON compacto (ShopBuddy) em vez de HTML/screenshot. Use para buscar produtos, comparar preço/frete/prazo, abrir produto, escolher variação, adicionar ao carrinho, ajustar o carrinho e consultar compras já feitas (quando, quanto, status).
---

# ShopBuddy

Projeto: `<REPO>` (extensão em `extension/`, CLI em `cli/`).
`window.ShopBuddy` transforma a página em JSON com ids curtos (`p3` produto, `a7` botão, `f2` campo, `v4` variação). Nunca leia HTML nem tire screenshot para entender a página: use `snap`.

## Caminho 1 — MCP chrome-devtools (Chrome do usuário, modo toggle/autoConnect)
1. Trabalhe numa aba sua: `new_page(url)`; não use as abas do usuário. Para a aba renderizar, ela precisa estar na frente: `select_page(pageId, bringToFront:true)`.
2. Se `ShopBuddy` não existir (extensão não carregada), injete sem gastar tokens:
   `evaluate_script(pageId, sourcePath:"<REPO>/extension/shopbuddy.js", format:"script")`.
3. Ler: `evaluate_script(function:"async () => ShopBuddy.s()")` → texto compacto (ou `ShopBuddy.snap({n:10, from:0})` para o objeto).
4. Agir: `() => ShopBuddy.click("p3")`, `() => ShopBuddy.type("f1","pilha aa",{enter:true})`, `() => ShopBuddy.select("f8","2")`,
   `() => ShopBuddy.search("resistor 10k","ml")`, `() => ShopBuddy.addToCart()`, `() => ShopBuddy.cart("ml")`,
   `() => ShopBuddy.find("frete")` (acha ids por texto), `() => ShopBuddy.read("a12")` (texto longo de um bloco).
   Carrinho: `() => ShopBuddy.setQty("p6", 3)` (via +/−, espera o total recalcular); remover = `click(item.del)`.
   Compras já feitas: `() => ShopBuddy.orders("ml")` abre a lista; `async () => ShopBuddy.orderInfo(["o1","o4"])` traz
   todos os produtos da compra (`items[{name,price,old,qty,variation}]`, preço já com desconto: a soma bate com o total)
   + valores/pagamento, por fetch, sem sair da lista (ML; ~2 s por compra; pacotes da mesma compra compartilham).
   A lista mostra só o 1º produto de cada pacote: para "o que veio nessa compra", use `orderInfo`.
   Buscar nos pedidos: `type(snap.searchBox, "resistor", {enter:true})` na página de pedidos (filtra as compras).
5. Depois de ação que navega, rode `s()` de novo (se der "context destroyed"/ShopBuddy undefined: espere ~1s, reinjete se preciso).
6. Se `ShopBuddy.click` não surtir efeito num botão, use `take_snapshot` + `click(uid)` do MCP só nesse passo.

## Caminho 2 — CLI (Chrome aberto com --remote-debugging-port; não funciona no modo toggle)
`node <REPO>/cli/sb.mjs <cmd>` — cada ação já imprime o snapshot novo.
`open ml|amazon|shopee|ali` · `search <q> --site ml` · `snap [--n 10 --from 10 --all]` · `click <id>` (clique real) · `type <id> <texto> --enter` ·
`select <id> <valor>` · `add [itemId]` · `cart` · `qty <id> <n>` · `orders` · `orderinfo [ids]` · `find <txt>` · `read <id>` · `scroll down` · `back` · `wait-user`. Porta: env `SB_CDP`.

## Lendo o JSON
- `page`: search | product | cart | checkout | orders | order | login | captcha | other. `items[]` na busca: `price`, `old` (preço riscado), `ship`, `full`, `prime`, `ad` (patrocinado), `intl`, `add` (botão direto), `alt` (outra oferta ML).
- `product`: `price`, `ship`, `stock`, `seller`, `variants[{name,opts:["v1:Azul [x]"]}]` ([x] = selecionada), `qty`, `add`, `buy`, `offers`.
- `cart`: `groups[{g,seller,ship,shipWas,hint}]` (ML: frete por vendedor; `hint` = quanto falta p/ frete grátis), `items[{id,g,name,price,old,qty,inc,dec,del,sel}]` (`sel` = checkbox "vai para o checkout"), `summary` (ML: `{"Produtos (n)":…, "Envios":…, "Total":…}` em números; outros sites: linhas), `checkout`, `empty`. `dialog` = popup/gaveta aberta (ex.: "adicionado ao carrinho").
- `page:"orders"`: `orders[{id,date,status,info,name,qty,seller,purchase,again,…}]` (ML: sem preço na lista → `orderInfo`; Ali: `number`, `items` "nome [variação] R$ x xN", `total`), `next` (próxima página / "ver mais pedidos": clique, espere ~3 s, snap), `searchBox`. `page:"order"`: detalhe (`amounts` com produtos/desconto/frete/pagamento/total).
- Pedidos ML por compra: o ML cobra por compra (carrinho fechado), não por item; itens com o mesmo `purchase` dividem o mesmo total.
- `next` = id da próxima página de resultados. `searchBox` = id do campo de busca. `warn` = aba em segundo plano (traga para frente).

## Regras
- `page:"captcha"` ou `"login"`: a página já mostra um aviso amarelo para o usuário. Diga ao usuário que é a vez dele, espere ele avisar (ou use `wait-user` no CLI) e rode `snap` de novo. Só peça atenção nesses casos.
- Preferência (ajuste à sua): produto com entrega mais rápida primeiro; com prazos iguais, o menor preço.
- Nunca clique em finalizar compra/pagar (`checkout`, `buy`, página `checkout`) sem confirmação explícita do usuário.
