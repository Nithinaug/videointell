package router

import (
	"github.com/gin-gonic/gin"

	"videointell/backend/internal/handlers"
)

type Deps struct {
	AuthHandler  *handlers.AuthHandler
	VideoHandler *handlers.VideoHandler
	LocalFiles   *handlers.LocalFilesHandler
	JWTSecret    string
}

func New(d Deps) *gin.Engine {
	r := gin.Default()
	r.Use(handlers.CORSMiddleware())

	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"status": "ok"}) })

	r.PUT("/local-upload/*key", d.LocalFiles.Upload)
	r.GET("/local-files/*key", d.LocalFiles.File)

	api := r.Group("/api")
	{
		api.POST("/auth/register", d.AuthHandler.Register)
		api.POST("/auth/login", d.AuthHandler.Login)

		videos := api.Group("/videos")
		videos.Use(handlers.AuthMiddleware(d.JWTSecret))
		{
			videos.POST("", d.VideoHandler.Create)
			videos.GET("", d.VideoHandler.List)
			videos.GET("/:id", d.VideoHandler.Detail)
			videos.POST("/:id/complete", d.VideoHandler.CompleteUpload)
		}
	}

	return r
}
