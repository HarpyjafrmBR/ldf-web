(function () {
  "use strict";

  /*
   * O conteúdo educativo fica separado da lógica do LDF Web. Essa divisão permite
   * revisar recomendações e referências sem alterar criptografia, PDFs ou contêineres.
   */
  window.LDFGuidanceContent = Object.freeze({
    version: "Beta 1.1.2",
    reviewedAt: "06/08/2026",
    introduction: {
      title: "Antes de interagir com um possível vestígio digital",
      text: "A primeira decisão deve reduzir o risco de alteração e preservar informações sobre a origem. Faça somente o que estiver autorizado, for seguro e estiver ao alcance da sua função."
    },
    principles: [
      {
        title: "Preserve o original",
        text: "Mantenha o conteúdo em seu formato de origem e evite qualquer ação desnecessária sobre o arquivo ou equipamento."
      },
      {
        title: "Registre o contexto",
        text: "Anote onde, quando, por quem e de que forma o conteúdo foi localizado, acessado ou copiado."
      },
      {
        title: "Documente a trajetória",
        text: "Registre cópias, transferências, responsáveis e verificações para que o percurso possa ser compreendido depois."
      }
    ],
    recommendations: [
      {
        id: "preserve",
        label: "Preservação",
        title: "Não altere o arquivo de origem",
        summary: "Uma operação aparentemente simples pode modificar conteúdo ou metadados.",
        items: [
          "Não edite, corte, converta, aplique filtros, recomprima ou renomeie o original sem necessidade documentada.",
          "Não mova nem apague a fonte. Quando possível e seguro, mantenha o original no dispositivo ou sistema de origem.",
          "Para análise ou envio, prefira uma cópia controlada e registre como ela foi produzida."
        ]
      },
      {
        id: "context",
        label: "Contexto",
        title: "Registre a fonte e as circunstâncias",
        summary: "O arquivo isolado raramente explica sozinho de onde veio e como se relaciona ao fato.",
        items: [
          "Anote data, hora, fuso horário, local, pessoa responsável, nome e tamanho do arquivo e método utilizado.",
          "Identifique, quando disponíveis, aparelho, marca, modelo, número de série, aplicativo, conta, perfil, sistema, câmera, URL ou equipamento de origem.",
          "Fotografe ou filme o local, o equipamento e o estado encontrado quando isso for autorizado, seguro e não ampliar desnecessariamente a exposição de conteúdo sensível."
        ]
      },
      {
        id: "volatile",
        label: "Urgência",
        title: "Comunique a transitoriedade dos dados",
        summary: "Alguns conteúdos podem desaparecer, mudar ou ser sobrescritos em pouco tempo.",
        items: [
          "Informe formalmente à autoridade competente quando houver mensagens temporárias, publicações efêmeras, transmissões ao vivo, logs de curta retenção ou gravações cíclicas de CFTV.",
          "Indique com precisão conta, perfil, URL, dispositivo, câmera, data, intervalo de tempo e risco conhecido de exclusão ou sobrescrita.",
          "Não improvise uma coleta invasiva por causa da urgência. Preserve o estado encontrado e solicite atendimento prioritário."
        ]
      },
      {
        id: "privacy",
        label: "Proteção de pessoas",
        title: "Preserve também a intimidade e a segurança",
        summary: "Documentar o contexto não significa expor pessoas ou dados sem relação com o fato.",
        items: [
          "Registre somente o contexto necessário e evite circular cópias por canais pessoais ou não autorizados.",
          "Não confronte a pessoa envolvida e não realize ações que coloquem você, a vítima ou terceiros em risco.",
          "Quando adequado, autorizado e sem ampliar a exposição de conteúdo sensível, registre quem acompanhou o procedimento, preferencialmente o responsável pelo equipamento ou pelo local."
        ]
      },
      {
        id: "tools",
        label: "Meios adequados",
        title: "Use ferramentas e profissionais capacitados",
        summary: "Computadores, smartphones, nuvem e sistemas proprietários exigem métodos diferentes.",
        items: [
          "Não contorne senhas, não desmonte equipamentos e não instale aplicativos desconhecidos de download, recuperação ou conversão.",
          "Em aquisições técnicas, use ferramentas forenses validadas ou testadas, previstas no procedimento institucional, e bloqueadores de escrita quando aplicáveis.",
          "Procure um núcleo de perícia criminal ou profissional capacitado diante de equipamento ligado, criptografia, acesso remoto, nuvem, sistema proprietário ou dúvida sobre o procedimento."
        ]
      },
      {
        id: "custody",
        label: "Integridade",
        title: "Documente a custódia e as verificações",
        summary: "A confiabilidade depende de controles técnicos acompanhados de registros compreensíveis.",
        items: [
          "Registre quem teve posse ou acesso, quando ocorreu cada transferência e qual foi a finalidade.",
          "Calcule o resumo criptográfico hash tão cedo quanto for tecnicamente adequado e preserve o valor junto da documentação.",
          "O hash ajuda a conferir identidade binária em outro momento, mas não comprova sozinho autoria, origem, veracidade do conteúdo ou regularidade da coleta."
        ]
      }
    ],
    specialistSupport: {
      title: "Pare e procure apoio especializado",
      introduction: "Evite novas interações e solicite orientação quando ocorrer uma destas situações:",
      items: [
        {
          lines: [
            "for necessária a coleta de dados voláteis com o equipamento ligado,",
            "ou quando o procedimento envolver sistemas em execução, conexões de rede e nuvem;"
          ]
        },
        "houver risco de sobrescrita, exclusão automática, criptografia ou perda de sessão;",
        "for necessário romper acesso, desmontar equipamento ou alterar sua configuração;",
        "o conteúdo envolver intimidade, crianças, adolescentes, ameaça ou risco pessoal;",
        "não for possível explicar e documentar com segurança o procedimento pretendido."
      ]
    },
    supportChannels: [
      {
        title: "Para cidadãos e notificantes",
        text: "Procure a autoridade policial competente. Onde disponível, a Delegacia Virtual permite comunicar ocorrências on-line; situações urgentes ou de risco exigem o canal de emergência da sua localidade."
      },
      {
        title: "Para agentes e instituições",
        text: "Acione o órgão central ou núcleo de perícia oficial de natureza criminal e siga os procedimentos operacionais e regras de competência da instituição."
      }
    ],
    sources: [
      {
        label: "Código de Processo Penal - cadeia de custódia, arts. 158-A a 158-F",
        url: "https://www.planalto.gov.br/ccivil_03/decreto-lei/del3689compilado.htm"
      },
      {
        label: "MJSP - Procedimentos Operacionais Padrão de Perícia Criminal",
        url: "https://www.gov.br/mj/pt-br/assuntos/sua-seguranca/seguranca-publica/analise-e-pesquisa/pop"
      },
      {
        label: "ABC - Nota Técnica nº 01/2026 sobre vestígios cibernéticos",
        url: "https://abcperitosoficiais.org.br/2026/05/25/nota-tecnica-01-2026-cadeia-custodia-vestigios-ciberneticos/"
      },
      {
        label: "Polícia Federal - orientações a vítimas de crimes cibernéticos",
        url: "https://www.gov.br/pf/pt-br/assuntos/combate-a-crimes-ciberneticos"
      },
      {
        label: "GOV.BR - registro de ocorrência policial on-line",
        url: "https://www.gov.br/pt-br/servicos/registrar-ocorrencia-policial-online"
      },
      {
        label: "NIST - diretrizes para perícia em dispositivos móveis",
        url: "https://csrc.nist.gov/pubs/sp/800/101/r1/final"
      },
      {
        label: "NIST - definição e uso de bloqueador de escrita",
        url: "https://csrc.nist.gov/glossary/term/write_blocker"
      },
      {
        label: "SWGDE - boas práticas para coleta de evidência digital",
        url: "https://www.swgde.org/documents/published-complete-listing/18-f-002-2-0/"
      }
    ],
    finalNote: "Menus, tecnologias e normas podem mudar. Em caso de dúvida, consulte fontes oficiais atualizadas e o procedimento aplicável à sua instituição."
  });
})();
