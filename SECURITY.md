# Política de segurança

## Versões acompanhadas

Somente a linha Beta `1.0.x` recebe análise nesta etapa. A presença do código em um
repositório público não demonstra, por si, que todos os gates técnicos da release
foram executados nem que a ferramenta atende automaticamente a todo contexto de uso.

## Como relatar uma vulnerabilidade

Use preferencialmente o recurso **Private vulnerability reporting** na aba
**Security** do [repositório oficial](https://github.com/HarpyjafrmBR/ldf-web).
Como canal alternativo, escreva para `contato_ldfweb@lacredigitalforense.seg.br` com o assunto
iniciado por `[SEGURANÇA]`. Não abra issue, discussion ou pull request público com
detalhes exploráveis.

No relato, use apenas dados sintéticos e informe:

- versão e hash/commit afetados;
- navegador e sistema operacional;
- pré-condições e impacto observado;
- passos mínimos de reprodução;
- sugestão de correção, se houver.

Não envie evidências reais, contêineres operacionais, chaves, nomes, CPFs, documentos,
perfis de navegador, certificados, credenciais ou outros dados pessoais ou sigilosos.
Use somente exemplos sintéticos e, antes de qualquer anexo, combine um meio seguro com
o Projeto LDF Web.

## Escopo prioritário

Recebem prioridade relatos sobre:

- perda de confidencialidade ou integridade do contêiner;
- download antes da verificação de hash;
- execução de código não incluído na release;
- rede depois do início da operação;
- vazamento de dados por cache, autofill, logs ou armazenamento;
- bypass de limites antes de leitura, hash, PBKDF2 ou alocação;
- mistura de versões pelo Service Worker;
- arquivos inesperados aceitos pelo build ou verificador.

## Limites da resposta

Não há SLA público definido nesta fase. O mantenedor deve confirmar o recebimento por
canal privado, preservar a evidência, classificar o risco e só divulgar detalhes após
correção e coordenação. Nenhuma recompensa financeira é prometida.
