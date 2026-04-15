# General informaiton

Goal of this helm chart is to provide developer and tester a way to run performance data generator on remote server.

Helm chart creates one time kubernetes job to generate data.

# Values

Create you own `values.yaml` using values.yaml as reference.


# Install/Upgrade from your laptop

Example of custom generate-data.yaml file**

```yaml
postgres:
  user: events_app
  password: plain_text_password
  host: postgres-0.postgres.opencrvs-deps-prod.svc.cluster.local

env:
  batchSize: 100
  sleepMs: 0
  count: 1000
```


**Install/upgrade command**

```
helm upgrade \
  --install \
  -f generate-data.yaml \
  generate-data-job chart/performance-test/
```


# Install/Upgrade from GitHub Actions workflow

**Example for CI/CD**

```yaml
env:
  batchSize: 100
  sleepMs: 0
  count: 1000
```

**Install/upgrade command**

Please create all required secrets/variables before adding this code snipped to GitHub actions

```
helm upgrade \
  --install \
  -f generate-data.yaml \
  --set postgres.user=${{ secrets.POSTGRES_USER }} \
  --set postgres.password=${{ secrets.POSTGRES_PASSWORD }} \
  --set postgres.host=${{ vars.POSTGRES_HOSTNAME }} \
  generate-data-job oci://ghcr.io/opencrvs/performance-test:0.1.0
```
