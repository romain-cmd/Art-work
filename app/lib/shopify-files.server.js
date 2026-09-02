// Envoie un fichier à Shopify (Files API) et renvoie son URL publique.
// Utilisé pour le logo d'une personnalisation et pour les images de proof.
//
// Cela se fait en 3 échanges avec Shopify :
// 1) On demande un emplacement d'upload temporaire (stagedUploadsCreate)
// 2) On y dépose le fichier brut
// 3) On demande à Shopify de l'enregistrer définitivement (fileCreate),
//    puis on vérifie quelques fois de suite si l'URL finale est prête,
//    car Shopify traite le fichier en arrière-plan.
//
// Chaque appel réseau a un délai maximum (timeout) : si Shopify ou le
// stockage externe ne répond pas, on obtient une erreur claire au lieu
// d'un blocage indéfini.
const NETWORK_TIMEOUT_MS = 20000;

export async function uploadFileToShopify(admin, file) {
  const mimeType = file.type || "application/octet-stream";
  const isImage = mimeType.startsWith("image/");

  console.log(`[uploadFileToShopify] 1/4 stagedUploadsCreate pour "${file.name}" (${file.size} octets)`);
  const stagedResponse = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        input: [
          {
            resource: "FILE",
            filename: file.name,
            mimeType,
            fileSize: String(file.size),
            httpMethod: "POST",
          },
        ],
      },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    }
  );
  const stagedJson = await stagedResponse.json();
  const stagedErrors = stagedJson.data.stagedUploadsCreate.userErrors;
  if (stagedErrors.length > 0) {
    throw new Error(stagedErrors.map((e) => e.message).join(", "));
  }
  const target = stagedJson.data.stagedUploadsCreate.stagedTargets[0];

  console.log(`[uploadFileToShopify] 2/4 dépôt du fichier sur ${target.url}`);
  const uploadForm = new FormData();
  for (const { name, value } of target.parameters) {
    uploadForm.append(name, value);
  }
  uploadForm.append("file", file, file.name);

  let uploadResponse;
  try {
    uploadResponse = await fetch(target.url, {
      method: "POST",
      body: uploadForm,
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Le dépôt du fichier n'a pas abouti (${error.name === "TimeoutError" ? "délai dépassé" : error.message}).`
    );
  }
  if (!uploadResponse.ok) {
    throw new Error("Échec de l'envoi du fichier vers Shopify.");
  }

  console.log("[uploadFileToShopify] 3/4 fileCreate");
  const fileCreateResponse = await admin.graphql(
    `#graphql
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            ... on MediaImage {
              image {
                url
              }
            }
            ... on GenericFile {
              url
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        files: [
          {
            alt: file.name,
            contentType: isImage ? "IMAGE" : "FILE",
            originalSource: target.resourceUrl,
          },
        ],
      },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    }
  );
  const fileJson = await fileCreateResponse.json();
  const fileErrors = fileJson.data.fileCreate.userErrors;
  if (fileErrors.length > 0) {
    throw new Error(fileErrors.map((e) => e.message).join(", "));
  }
  const createdFile = fileJson.data.fileCreate.files[0];

  console.log(`[uploadFileToShopify] 4/4 attente du traitement (id: ${createdFile.id})`);
  let url = createdFile.image?.url ?? createdFile.url ?? null;
  let attempts = 0;

  while (!url && attempts < 5) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const checkResponse = await admin.graphql(
      `#graphql
        query checkFile($id: ID!) {
          node(id: $id) {
            ... on MediaImage {
              image {
                url
              }
            }
            ... on GenericFile {
              url
            }
          }
        }`,
      { variables: { id: createdFile.id }, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) }
    );
    const checkJson = await checkResponse.json();
    url = checkJson.data.node?.image?.url ?? checkJson.data.node?.url ?? null;
    attempts += 1;
    console.log(`[uploadFileToShopify]     tentative ${attempts}/5 — url prête : ${Boolean(url)}`);
  }

  console.log(`[uploadFileToShopify] terminé — url: ${url}`);
  return url;
}
