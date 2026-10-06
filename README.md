# LDF Web v2.0.0

**Canal de release:** Beta

O LDF Web — Lacre Digital Forense é uma aplicação estática e local-first destinada
a acondicionar, documentar e proteger vestígios digitais sem upload do conteúdo.

Antes de usar ou redistribuir, leia `LICENSE.md`, `SECURITY.md` e
o [manifesto da exportação](PUBLIC_EXPORT_MANIFEST.json). A aplicação pronta para
uso está em [`public/`](public/); seus arquivos e hashes constam em
[`public/release-manifest.json`](public/release-manifest.json) e
[`public/SHA256SUMS.txt`](public/SHA256SUMS.txt). A presença dos arquivos não prova
autenticidade externa; confirme o commit e os hashes por canal independente.

- Repositório oficial: [HarpyjafrmBR/ldf-web](https://github.com/HarpyjafrmBR/ldf-web)
- Contato: `contato_ldfweb@lacredigitalforense.seg.br`
- Site oficial: `https://lacredigitalforense.seg.br`

## Compatibilidade

A versão 2.0.0 mantém os formatos `LDF-WEB-1` e `LDF-MANIFEST-1`, com regras de
qualificação mais estritas. Lotes antigos com nomes, CPF ou datas incompatíveis
com essas regras são rejeitados, sem alteração dos arquivos originais.
Lotes novos com identificação de 1 ou 2 caracteres podem ser rejeitados por
leitores anteriores. Use a versão atual para fechamento e abertura.

O versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

Todos os direitos reservados ao Projeto LDF Web.
