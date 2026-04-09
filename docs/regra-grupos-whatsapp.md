# Regra global de negocio para grupos de WhatsApp

Este documento resume a regra global que o `worker_baileys` deve espelhar operacionalmente.

O `dispatcher_baileys` decide quem pode entrar ou sair. O `worker_baileys` executa essa decisao no WhatsApp usando a mesma taxonomia de grupos.

## Tipos de grupo gerenciados

Somente dois tipos de grupo entram na automacao:

- `MB`
- `RJB`

Qualquer outro grupo fica fora do fluxo automatico de add/remove.

## Como os grupos sao classificados

### MB

Grupo `MB` e qualquer grupo cujo nome:

- comeca com `Mensa` e contem `Regional`; ou
- comeca com `Avisos Mensa`; ou
- comeca com `MB |`.

### RJB

Grupo `RJB` e qualquer grupo cujo nome:

- comeca com `R.JB |`; ou
- comeca com `R. JB |`.

## Regra operacional que o worker aplica

### Adicao em MB

Quando o item de fila vier como `MB`, o worker deve tentar apenas:

- telefones do proprio cadastro do membro;
- nunca telefones de responsavel legal.

### Adicao em RJB

Quando o item de fila vier como `RJB`, o worker deve tentar apenas:

- telefones marcados como telefone de responsavel legal;
- nunca o telefone do proprio menor, salvo se esse mesmo telefone estiver cadastrado no bloco de responsavel.

### Remocao

O worker nao recalcula regra de negocio para remocao.

Ele apenas executa a remocao enfileirada pelo `dispatcher_baileys`, que agora segue a regra global:

- `MB`: somente membro adulto ativo com telefone no cadastro do membro;
- `RJB`: somente telefone de responsavel de menor ativo;
- `suspensao` vence `convidado`;
- inatividade e telefone nao encontrado respeitam carencia iniciada pela primeira mensagem automatica.

## Resultado pratico

- `MB` = grupos gerais de membros adultos ativos.
- `RJB` = grupos de responsaveis de menores ativos.
